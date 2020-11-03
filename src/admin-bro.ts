import * as _ from 'lodash'
import * as path from 'path'
import * as fs from 'fs'
import i18n, { i18n as I18n } from 'i18next'

import { AdminBroOptionsWithDefault, AdminBroOptions } from './admin-bro-options.interface'
import BaseResource from './backend/adapters/resource/base-resource'
import BaseDatabase from './backend/adapters/database/base-database'
import ConfigurationError from './backend/utils/errors/configuration-error'
import ResourcesFactory from './backend/utils/resources-factory/resources-factory'
import userComponentsBundler from './backend/bundler/user-components-bundler'
import { RecordActionResponse, Action } from './backend/actions/action.interface'
import { DEFAULT_PATHS } from './constants'
import { ACTIONS } from './backend/actions'

import loginTemplate from './frontend/login-template'
import { ListActionResponse } from './backend/actions/list/list-action'
import { combineTranslations, Locale } from './locale/config'
import en from './locale/en'
import { TranslateFunctions, createFunctions } from './utils/translate-functions.factory'
import { OverridableComponent } from './frontend/utils/overridable-component'
import { relativeFilePathResolver } from './utils/file-resolver'

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8'))
export const VERSION = pkg.version


export const defaultOptions: AdminBroOptionsWithDefault = {
  rootPath: DEFAULT_PATHS.rootPath,
  logoutPath: DEFAULT_PATHS.logoutPath,
  loginPath: DEFAULT_PATHS.loginPath,
  databases: [],
  resources: [],
  dashboard: {},
  pages: {},
  bundler: {},
}

type ActionsMap = {
  show: Action<RecordActionResponse>;
  edit: Action<RecordActionResponse>;
  delete: Action<RecordActionResponse>;
  new: Action<RecordActionResponse>;
  list: Action<ListActionResponse>;
}

export type Adapter = { Database: typeof BaseDatabase; Resource: typeof BaseResource }

/**
 * Main class for AdminBro extension. It takes {@link AdminBroOptions} as a
 * parameter and creates an admin instance.
 *
 * Its main responsibility is to fetch all the resources and/or databases given by a
 * user. Its instance is a currier - injected in all other classes.
 *
 * @example
 * const AdminBro = require('admin-bro')
 * const admin = new AdminBro(AdminBroOptions)
 */
class AdminBro {
  public resources: Array<BaseResource>

  public options: AdminBroOptionsWithDefault

  public locale!: Locale

  public i18n!: I18n

  public translateFunctions!: TranslateFunctions

  /**
   * List of all default actions. If you want to change the behavior for all actions like:
   * _list_, _edit_, _show_, _delete_ and _bulkDelete_ you can do this here.
   *
   * @example <caption>Modifying accessibility rules for all show actions</caption>
   * const { ACTIONS } = require('admin-bro')
   * ACTIONS.show.isAccessible = () => {...}
   */
  public static ACTIONS: ActionsMap

  /**
   * AdminBro version
   */
  public static VERSION: string

  /**
   * @param   {AdminBroOptions} options      Options passed to AdminBro
   */
  constructor(options: AdminBroOptions = {}) {
    /**
     * @type {BaseResource[]}
     * @description List of all resources available for the AdminBro.
     * They can be fetched with the {@link AdminBro#findResource} method
     */
    this.resources = []

    /**
     * @type {AdminBroOptions}
     * @description Options given by a user
     */
    this.options = _.merge({}, defaultOptions, options)

    this.resolveBabelConfigPath()

    this.initI18n()

    const { databases, resources } = this.options
    const resourcesFactory = new ResourcesFactory(this, global.RegisteredAdapters || [])
    this.resources = resourcesFactory.buildResources({ databases, resources })
  }

  initI18n(): void {
    this.locale = {
      translations: combineTranslations(en.translations, this.options.locale?.translations),
      language: this.options.locale?.language || en.language,
    }
    if (i18n.isInitialized) {
      i18n.addResourceBundle(this.locale.language, 'translation', this.locale.translations)
    } else {
      i18n.init({
        lng: this.locale.language,
        initImmediate: false, // loads translations immediately
        resources: {
          [this.locale.language]: {
            translation: this.locale.translations,
          },
        },
      })
    }

    // mixin translate functions to AdminBro instance so users will be able to
    // call adminBro.translateMessage(...)
    this.translateFunctions = createFunctions(i18n)
    Object.getOwnPropertyNames(this.translateFunctions).forEach((translateFunctionName) => {
      this[translateFunctionName] = this.translateFunctions[translateFunctionName]
    })
  }

  /**
   * Registers various database adapters written for AdminBro.
   *
   * @example
   * const AdminBro = require('admin-bro')
   * const MongooseAdapter = require('admin-bro-mongoose')
   * AdminBro.registerAdapter(MongooseAdapter)
   *
   * @param  {Object}       options
   * @param  {typeof BaseDatabase} options.Database subclass of {@link BaseDatabase}
   * @param  {typeof BaseResource} options.Resource subclass of {@link BaseResource}
   */
  static registerAdapter({ Database, Resource }: {
    Database: typeof BaseDatabase;
    Resource: typeof BaseResource;
  }): void {
    if (!Database || !Resource) {
      throw new Error('Adapter has to have both Database and Resource')
    }
    // checking if both Database and Resource have at least isAdapterFor method
    if (Database.isAdapterFor && Resource.isAdapterFor) {
      global.RegisteredAdapters = global.RegisteredAdapters || []
      global.RegisteredAdapters.push({ Database, Resource })
    } else {
      throw new Error('Adapter elements has to be a subclass of AdminBro.BaseResource and AdminBro.BaseDatabase')
    }
  }

  /**
   * Initializes AdminBro instance in production. This function should be called by
   * all external plugins.
   */
  async initialize(): Promise<void> {
    if (process.env.NODE_ENV === 'production'
        && !(process.env.ADMIN_BRO_SKIP_BUNDLE === 'true')) {
      // eslint-disable-next-line no-console
      console.log('AdminBro: bundling user components...')
      await userComponentsBundler(this, { write: true })
    }
  }

  /**
   * Watches for local changes in files imported via {@link AdminBro.bundle}.
   * It doesn't work on production environment.
   *
   * @return  {Promise<never>}
   */
  async watch(): Promise<string | undefined> {
    if (process.env.NODE_ENV !== 'production') {
      return userComponentsBundler(this, { write: true, watch: true })
    }
    return undefined
  }

  /**
   * Renders an entire login page with email and password fields
   * using {@link Renderer}.
   *
   * Used by external plugins
   *
   * @param  {Object} options
   * @param  {String} options.action          Login form action url - it could be
   *                                          '/admin/login'
   * @param  {String} [options.errorMessage]  Optional error message. When set,
   *                                          renderer will print this message in
   *                                          the form
   * @return {Promise<string>}                HTML of the rendered page
   */
  async renderLogin({ action, errorMessage }): Promise<string> {
    return loginTemplate(this, { action, errorMessage })
  }

  /**
   * Returns resource base on its ID
   *
   * @example
   * const User = admin.findResource('users')
   * await User.findOne(userId)
   *
   * @param  {String} resourceId    ID of a resource defined under {@link BaseResource#id}
   * @return {BaseResource}         found resource
   * @throws {Error}                When resource with given id cannot be found
   */
  findResource(resourceId): BaseResource {
    const resource = this.resources.find(m => m._decorated?.id() === resourceId)
    if (!resource) {
      throw new Error([
        `There are no resources with given id: "${resourceId}"`,
        'This is the list of all registered resources you can use:',
        this.resources.map(r => r._decorated?.id() || r.id()).join(', '),
      ].join('\n'))
    }
    return resource
  }

  /**
   * Resolve babel config file path,
   * and load configuration to this.options.bundler.babelConfig.
   */
  resolveBabelConfigPath(): void {
    if (typeof this.options?.bundler?.babelConfig !== 'string') {
      return
    }
    let filePath = ''
    let config = this.options?.bundler?.babelConfig
    if (config[0] === '/') {
      filePath = config
    } else {
      filePath = relativeFilePathResolver(config, /new AdminBro/)
    }

    if (!fs.existsSync(filePath)) {
      throw new ConfigurationError(`Given babel config "${filePath}", doesn't exist.`, 'AdminBro.html')
    }
    if (path.extname(filePath) === '.js') {
      // eslint-disable-next-line
      const configModule = require(filePath)
      config = configModule && configModule.__esModule
        ? configModule.default || undefined
        : configModule
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(
          `${filePath}: Configuration should be an exported JavaScript object.`,
        )
      }
    } else {
      try {
        config = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      } catch (err) {
        throw new Error(`${filePath}: Error while parsing config - ${err.message}`)
      }
      if (!config) throw new Error(`${filePath}: No config detected`)
      if (typeof config !== 'object') {
        throw new Error(`${filePath}: Config returned typeof ${typeof config}`)
      }
      if (Array.isArray(config)) {
        throw new Error(`${filePath}: Expected config object but found array`)
      }
    }
    this.options.bundler.babelConfig = config
  }

  /**
   * Requires given `.jsx/.tsx` file, that it can be bundled to the frontend.
   * It will be available under AdminBro.UserComponents[componentId].
   *
   * @param   {String}  src  Path to a file containing react component.
   *
   * @param  {OverridableComponent}  [componentName] - name of the component which you want
   *                                  to override
   * @returns {String}                componentId - uniq id of a component
   *
   * @example <caption>Passing custom components in AdminBro options</caption>
   * const adminBroOptions = {
   *   dashboard: {
   *     component: AdminBro.bundle('./path/to/component'),
   *   }
   * }
   * @example <caption>Overriding AdminBro core components</caption>
   * // somewhere in the code
   * AdminBro.bundle('./path/to/new-sidebar/component', 'SidebarFooter')
   */
  public static bundle(src: string, componentName?: OverridableComponent): string {
    const nextId = Object.keys(global.UserComponents || {}).length + 1
    const extensions = ['.jsx', '.js', '.ts', '.tsx']
    let filePath = ''
    const componentId = componentName || `Component${nextId}`
    if (src[0] === '/') {
      filePath = src
    } else {
      filePath = relativeFilePathResolver(src, /Function\.bundle/)
    }

    const { root, dir, name } = path.parse(filePath)
    if (!extensions.find((ext) => {
      const fileName = path.format({ root, dir, name, ext })
      return fs.existsSync(fileName)
    })) {
      throw new ConfigurationError(`Given file "${src}", doesn't exist.`, 'AdminBro.html')
    }

    // We have to put this to the global scope because of the NPM resolution. If we put this to
    // let say `AdminBro.UserComponents` (static member) it wont work in a case where user uses
    // AdminBro.bundle from a different packages (i.e. from the extension) because there, there
    // is an another AdminBro version (npm installs different versions for each package). Also
    // putting admin to peerDependencies wont solve this issue, because in the development mode
    // we have to install admin-bro it as a devDependency, because we want to run test or have
    // proper types.
    global.UserComponents = global.UserComponents || {}
    global.UserComponents[componentId] = path.format({ root, dir, name })

    return componentId
  }
}

AdminBro.VERSION = VERSION
AdminBro.ACTIONS = ACTIONS

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface AdminBro extends TranslateFunctions {}

export const { registerAdapter } = AdminBro
export const { bundle } = AdminBro

export default AdminBro
