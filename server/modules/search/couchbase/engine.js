const _ = require('lodash')
const couchbase = require('couchbase')
const { resolveConfig, missingConfigKeys, isIndexDefinitionCurrent, docKey, buildDoc, buildSearchQuery, buildSuggestQuery, staleKeys } = require('./helpers')
const indexDefinition = require('./index-definition.json')

// Bounds the parallel removes during a rebuild, so a large stale set cannot
// open thousands of concurrent KV operations at once.
const REMOVE_CONCURRENCY = 16

// Keep the pre-flight probe short: it runs inline while an administrator waits
// on the Save button in the Administration Area.
const PROBE_TIMEOUT = 5000
const PROBE_KEY = '__wikijs_activation_probe__'

// A freshly written index is not searchable until the Search service has built
// its partitions, so the activation probe gives it a little time rather than
// mistaking a build in progress for a broken configuration.
const INDEX_READY_TIMEOUT = 20000
const INDEX_READY_INTERVAL = 2000

// Distinguishes 'you may not do this' from 'not yet'. Only the former should
// block activation; the latter resolves itself once the build finishes.
function isAccessError (err) {
  return err instanceof couchbase.AuthenticationFailureError ||
    /forbidden|unauthorized|not authorized|access denied|permission/i.test(err.message || '')
}

// The type mapping in index-definition.json is keyed by scope.collection. The
// file ships one, and it is retargeted at whatever scope/collection is
// configured, so read the key rather than repeating the literal.
const TEMPLATE_TYPE_KEY = Object.keys(indexDefinition.params.mapping.types)[0]

function connectOptions (cfg, timeouts) {
  return {
    username: cfg.username,
    password: cfg.password,
    ...(cfg.verifyTLSCertificate ? {} : { security: { trustOnlyCapella: false } }),
    ...(timeouts ? { timeouts } : {})
  }
}

/* global WIKI */

module.exports = {
  /**
   * ACTIVATE
   *
   * Runs before the engine is enabled. WIKI.models.searchEngines.initEngine()
   * rethrows SearchActivationFailed, so anything raised here is reported in the
   * Administration Area and the previous engine is kept. Everything the engine
   * needs is therefore proven here rather than in init(), whose errors are
   * swallowed into a log line nobody sees.
   */
  async activate() {
    const cfg = resolveConfig(this.config)

    const missing = missingConfigKeys(cfg)
    if (missing.length > 0) {
      throw new WIKI.Error.SearchActivationFailed(`Couchbase search is missing required settings: ${missing.join(', ')}. Set them here, or supply the matching CB_* environment variables.`)
    }

    let probe
    try {
      probe = await couchbase.connect(cfg.connectionString, connectOptions(cfg, {
        connectTimeout: PROBE_TIMEOUT,
        bootstrapTimeout: PROBE_TIMEOUT,
        kvTimeout: PROBE_TIMEOUT,
        managementTimeout: PROBE_TIMEOUT,
        searchTimeout: PROBE_TIMEOUT
      }))
    } catch (err) {
      throw new WIKI.Error.SearchActivationFailed(`Could not connect to Couchbase at ${cfg.connectionString} as ${cfg.username}: ${err.message}`)
    }

    try {
      // A successful connect proves neither that the bucket, scope and
      // collection exist nor that this credential may read them, so touch the
      // exact collection the engine will use.
      await probe
        .bucket(cfg.bucketName)
        .scope(cfg.scopeName)
        .collection(cfg.collectionName)
        .exists(PROBE_KEY)
    } catch (err) {
      throw new WIKI.Error.SearchActivationFailed(`Connected to Couchbase, but could not read ${cfg.bucketName}.${cfg.scopeName}.${cfg.collectionName} as ${cfg.username}: ${err.message}`)
    }

    const probeScope = probe.bucket(cfg.bucketName).scope(cfg.scopeName)

    try {
      // The index has to exist before it can be searched, and init() -- which
      // would create it -- only runs once activation has succeeded. Creating it
      // here is what lets a fresh cluster bootstrap at all, and it doubles as
      // the check for index-management access (fts_admin on Capella).
      await this.ensureIndex(probeScope, cfg)
    } catch (err) {
      throw new WIKI.Error.SearchActivationFailed(`Connected to Couchbase, but could not create or read index ${cfg.indexName} as ${cfg.username}: ${err.message}. On Capella the credential needs index-management access (fts_admin); otherwise create the index out of band.`)
    }

    try {
      // Reading documents proves nothing about search: a credential may pass
      // every check above and still be unable to run a query, which would
      // leave search silently returning nothing. Run a real search so that is
      // refused here rather than surfacing as empty results forever.
      //
      // An index written moments ago reports 'index not ready' until its
      // partitions are built, so poll for a while before giving up, and only
      // refuse outright when the cluster says this credential may not search.
      const deadline = Date.now() + INDEX_READY_TIMEOUT
      let lastError = null
      for (;;) {
        try {
          await probeScope.search(cfg.indexName, couchbase.SearchRequest.create(couchbase.SearchQuery.matchNone()), { limit: 1 })
          lastError = null
          break
        } catch (err) {
          if (isAccessError(err)) {
            throw new WIKI.Error.SearchActivationFailed(`Connected to Couchbase, but this credential may not search index ${cfg.indexName}: ${err.message}. On Capella, grant search access to ${cfg.username} through an advanced access credential.`)
          }
          lastError = err
          if (Date.now() >= deadline) {
            break
          }
          WIKI.logger.info(`(SEARCH/COUCHBASE) Index ${cfg.indexName} is not ready yet (${err.message}); waiting for the Search service to build it...`)
          await new Promise(resolve => setTimeout(resolve, INDEX_READY_INTERVAL))
        }
      }
      if (lastError) {
        // The index exists and nothing said access was denied, so it is still
        // building. Enabling the engine is correct; searches return nothing
        // until the build finishes.
        WIKI.logger.warn(`(SEARCH/COUCHBASE) Index ${cfg.indexName} was still not searchable after ${INDEX_READY_TIMEOUT / 1000}s (${lastError.message}). Enabling anyway: the Search service is still building it, and searches will return nothing until it finishes.`)
      }
    } finally {
      try {
        await probe.close()
      } catch (err) {
        WIKI.logger.warn(`(SEARCH/COUCHBASE) Could not close the activation probe connection: ${err.message}`)
      }
    }
  },
  /**
   * Guard for anything that touches Couchbase.
   *
   * init() failures are logged but not fatal, so without this the page
   * lifecycle hooks would throw an opaque TypeError on undefined.upsert in the
   * middle of saving a page. Costs no round trip, so every write can afford it.
   */
  assertConnected() {
    if (!this.collection || !this.scope) {
      throw new WIKI.Error.SearchGenericError('Couchbase search is not connected. Check the engine settings in the Administration Area; the server log holds the connection error.')
    }
  },
  /**
   * Guard for a full rebuild, which additionally needs a usable index:
   * indexing into a missing index would report success while storing documents
   * nothing can search. Costs a round trip, so it is not used per page save.
   */
  async assertReady() {
    this.assertConnected()
    try {
      await this.scope.searchIndexes().getIndex(this.cfg.indexName)
    } catch (err) {
      throw new WIKI.Error.SearchGenericError(`Search index ${this.cfg.indexName} is missing or unreadable: ${err.message}. Indexing now would store documents that nothing can search.`)
    }
  },
  async deactivate() {
    // The scope and collection are owned by Terraform in deployed environments
    // and by the couchbase-init service locally. Dropping them here would
    // create drift, so this engine leaves its objects in place.
  },
  /**
   * INIT
   */
  async init() {
    WIKI.logger.info(`(SEARCH/COUCHBASE) Initializing...`)
    this.cfg = resolveConfig(this.config)

    // WIKI.models.searchEngines.initEngine() catches errors from init() and
    // logs them with a bare warn, so a failed connection otherwise surfaces as
    // an unattributed 'unambiguous timeout'. Name the culprit before rethrowing.
    try {
      this.cluster = await couchbase.connect(this.cfg.connectionString, connectOptions(this.cfg))
    } catch (err) {
      WIKI.logger.error(`(SEARCH/COUCHBASE) Could not connect to ${this.cfg.connectionString} as ${this.cfg.username}: ${err.message}`)
      WIKI.logger.error(`(SEARCH/COUCHBASE) Search is disabled until this is fixed. Check the connection string in the Administration Area, or clear it to fall back to the CB_CONNECTION_STRING environment variable.`)
      throw err
    }
    this.bucket = this.cluster.bucket(this.cfg.bucketName)
    this.scope = this.bucket.scope(this.cfg.scopeName)
    this.collection = this.scope.collection(this.cfg.collectionName)

    await this.createIndex()

    WIKI.logger.info(`(SEARCH/COUCHBASE) Initialization completed.`)
  },
  /**
   * Build the index definition for a given scope and collection.
   */
  buildIndexDefinition(cfg) {
    return {
      ...indexDefinition,
      name: cfg.indexName,
      sourceName: cfg.bucketName,
      params: {
        ...indexDefinition.params,
        mapping: {
          ...indexDefinition.params.mapping,
          types: {
            [`${cfg.scopeName}.${cfg.collectionName}`]:
              indexDefinition.params.mapping.types[TEMPLATE_TYPE_KEY]
          }
        }
      }
    }
  },
  /**
   * Create or update the scope-level FTS index, unless it already expresses the
   * definition we want.
   *
   * Writing an unchanged definition makes the Search service reindex, and
   * queries fail with 'pindex not available' while that runs, so only write
   * when something actually differs. The live definition carries defaults the
   * server filled in, hence a subset comparison rather than equality.
   *
   * Throws on failure. activate() lets that surface so a missing grant is
   * refused in the UI; init() logs it and carries on, because an index created
   * out of band is a legitimate setup.
   */
  async ensureIndex(scope, cfg) {
    const manager = scope.searchIndexes()
    const definition = this.buildIndexDefinition(cfg)

    let existing = null
    try {
      existing = await manager.getIndex(cfg.indexName)
    } catch (err) {
      WIKI.logger.info(`(SEARCH/COUCHBASE) Index ${cfg.indexName} not found, creating it...`)
    }

    if (isIndexDefinitionCurrent(existing, definition)) {
      WIKI.logger.info(`(SEARCH/COUCHBASE) Index ${cfg.indexName} already matches; leaving it untouched.`)
      return
    }

    if (existing) {
      definition.uuid = existing.uuid
      definition.sourceUuid = existing.sourceUuid
    }

    await manager.upsertIndex(definition)
    WIKI.logger.info(`(SEARCH/COUCHBASE) Index ${cfg.indexName} written. The Search service will reindex; queries may fail until that finishes.`)
  },
  /**
   * CREATE INDEX
   *
   * Non-fatal on purpose: an index created out of band is a legitimate setup
   * (on Capella the credential may not be allowed to manage indexes), and
   * activate() has already proven the index is searchable by this point.
   */
  async createIndex() {
    try {
      await this.ensureIndex(this.scope, this.cfg)
    } catch (err) {
      WIKI.logger.error(`(SEARCH/COUCHBASE) Could not create or update index ${this.cfg.indexName}: ${err.message}`)
      WIKI.logger.error(`(SEARCH/COUCHBASE) Search will not return results until that index exists. On Capella this usually means the database credential lacks index-management access: create the index manually and restart.`)
    }
  },
  /**
   * QUERY
   *
   * The GraphQL resolver filters results by permission and pages them itself,
   * so this returns every hit up to maxResults rather than a single page.
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q, opts) {
    try {
      const request = couchbase.SearchRequest.create(buildSearchQuery(couchbase, q, opts))
      const response = await this.scope.search(this.cfg.indexName, request, {
        limit: this.cfg.maxResults,
        fields: ['id', 'path', 'locale', 'tags', 'title', 'description']
      })

      // title and description are stored in the index because the resolver
      // returns them to the client untouched; it only fills in snippet and
      // anchor. content is deliberately not stored: it is large, and snippets
      // are rebuilt from the rendered page in the primary database.
      const results = response.rows.map(row => ({
        id: String(_.get(row.fields, 'id', '')),
        path: _.get(row.fields, 'path', ''),
        locale: _.get(row.fields, 'locale', ''),
        title: _.get(row.fields, 'title', ''),
        description: _.get(row.fields, 'description', ''),
        tags: _.compact(_.castArray(_.get(row.fields, 'tags', [])))
      }))

      let suggestions = []
      if (results.length < 5) {
        suggestions = await this.suggest(q)
      }

      return {
        results,
        suggestions,
        totalHits: results.length
      }
    } catch (err) {
      WIKI.logger.warn('Search Engine Error:')
      WIKI.logger.warn(err)
      return { results: [], suggestions: [], totalHits: 0 }
    }
  },
  /**
   * SUGGEST
   *
   * FTS has no suggester. On a near miss, run one fuzzy title query and return
   * the distinct titles it turns up.
   */
  async suggest(q) {
    try {
      const request = couchbase.SearchRequest.create(buildSuggestQuery(couchbase, q))
      const response = await this.scope.search(this.cfg.indexName, request, {
        limit: 5,
        fields: ['title']
      })
      return _.uniq(
        response.rows
          .map(row => _.get(row.fields, 'title', ''))
          .filter(title => title.length > 0)
      )
    } catch (err) {
      WIKI.logger.warn(`(SEARCH/COUCHBASE) Suggestion query failed: ${err.message}`)
      return []
    }
  },
  /**
   * Fetch a page's tags.
   *
   * They are not part of the page object handed to the engine, but the GraphQL
   * resolver needs them to evaluate tag-scoped permissions on every result.
   */
  async buildTags(id) {
    // 'pages.id' is qualified: withGraphJoined('tags') brings tags.id into
    // scope, and an unqualified id is ambiguous in the generated SQL.
    const page = await WIKI.models.pages.query().findById(id).select('pages.id').withGraphJoined('tags')
    return _.get(page, 'tags', []).map(t => t.tag)
  },
  /**
   * CREATE
   *
   * @param {Object} page Page to create
   */
  /**
   * Write one page to its document key.
   *
   * `content` is the markdown source (getPageFromDb selects pages.content).
   * Deliberately not page.searchContent, which flattens every block into one
   * ' | '-joined string and cannot be chunked downstream.
   */
  async upsertPage({ locale, path, page, tags }) {
    this.assertConnected()
    await this.collection.upsert(
      docKey(locale, path),
      buildDoc({
        id: page.id,
        path,
        locale,
        title: page.title,
        description: page.description,
        tags,
        content: page.content
      })
    )
  },
  async created(page) {
    await this.upsertPage({
      locale: page.localeCode,
      path: page.path,
      page,
      tags: await this.buildTags(page.id)
    })
  },
  /**
   * UPDATE
   *
   * The key is derived from locale and path, so an update writes over the same
   * document a create would have written.
   *
   * @param {Object} page Page to update
   */
  async updated(page) {
    await this.created(page)
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    this.assertConnected()
    try {
      await this.collection.remove(docKey(page.localeCode, page.path))
    } catch (err) {
      if (!(err instanceof couchbase.DocumentNotFoundError)) {
        throw err
      }
    }
  },
  /**
   * RENAME
   *
   * The key encodes locale and path, so a rename is a delete followed by an
   * insert at the new key.
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    await this.deleted(page)
    await this.upsertPage({
      locale: page.destinationLocaleCode,
      path: page.destinationPath,
      page,
      tags: await this.buildTags(page.id)
    })
  },
  /**
   * REBUILD INDEX
   *
   * Upserts every published page, then removes documents whose key is no
   * longer in the current page set.
   *
   * Pure key-value throughout: the key listing uses a KV range scan, so the
   * collection needs no primary index and the credential needs no query
   * privilege.
   */
  async rebuild() {
    await this.assertReady()
    WIKI.logger.info(`(SEARCH/COUCHBASE) Rebuilding Index...`)

    // Columns are qualified because withGraphJoined('tags') brings a second
    // table with its own id column into scope.
    const pages = await WIKI.models.pages.query()
      .column('pages.id', 'pages.path', 'pages.localeCode', 'pages.title', 'pages.description', 'pages.content')
      .withGraphJoined('tags')
      .modifyGraph('tags', builder => builder.select('tag'))
      .where({ 'pages.isPublished': true, 'pages.isPrivate': false })

    const currentKeys = new Set()
    for (const page of pages) {
      currentKeys.add(docKey(page.localeCode, page.path))
      await this.upsertPage({
        locale: page.localeCode,
        path: page.path,
        page,
        tags: _.get(page, 'tags', []).map(t => t.tag)
      })
    }
    WIKI.logger.info(`(SEARCH/COUCHBASE) Indexed ${currentKeys.size} pages.`)

    const scanned = await this.collection.scan(new couchbase.RangeScan(), { idsOnly: true })
    const stale = staleKeys(scanned.map(row => row.id), currentKeys)

    for (const batch of _.chunk(stale, REMOVE_CONCURRENCY)) {
      await Promise.all(batch.map(key => this.collection.remove(key).catch(err => {
        if (!(err instanceof couchbase.DocumentNotFoundError)) {
          throw err
        }
      })))
    }
    WIKI.logger.info(`(SEARCH/COUCHBASE) Removed ${stale.length} stale documents.`)

    WIKI.logger.info(`(SEARCH/COUCHBASE) Index rebuilt successfully.`)
  }
}
