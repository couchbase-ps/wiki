const _ = require('lodash')

const ENV_FALLBACKS = {
  connectionString: 'CB_CONNECTION_STRING',
  username: 'CB_USER',
  password: 'CB_PASSWORD',
  bucketName: 'CB_BUCKET',
  scopeName: 'CB_SCOPE',
  collectionName: 'CB_COLLECTION',
  indexName: 'CB_FTS_INDEX'
}

/**
 * Apply environment fallbacks to a stored module config.
 * A stored value always wins; the environment only fills in blanks, so the
 * admin area never displays a value that is silently ignored.
 */
function resolveConfig (config, env = process.env) {
  const resolved = { ...config }
  _.forEach(ENV_FALLBACKS, (envKey, propKey) => {
    if (_.isEmpty(resolved[propKey]) && !_.isEmpty(env[envKey])) {
      resolved[propKey] = env[envKey]
    }
  })
  return resolved
}

/**
 * Drop false and null values recursively.
 *
 * The Search service omits false-valued flags when it stores an index
 * definition, so a field we send as `"store": false` comes back absent.
 * Without this, a stored definition never compares equal to the one on disk.
 */
function pruneDisabledFlags (value) {
  if (_.isArray(value)) {
    return value.map(pruneDisabledFlags)
  }
  if (_.isPlainObject(value)) {
    return _.transform(value, (result, item, key) => {
      if (item === false || _.isNil(item)) {
        return
      }
      result[key] = pruneDisabledFlags(item)
    }, {})
  }
  return value
}

function isDeepSubset (want, have) {
  if (_.isArray(want)) {
    return _.isArray(have) && want.length === have.length &&
      want.every((item, idx) => isDeepSubset(item, have[idx]))
  }
  if (_.isPlainObject(want)) {
    return _.isPlainObject(have) &&
      Object.keys(want).every(key => isDeepSubset(want[key], have[key]))
  }
  return _.isEqual(want, have)
}

/**
 * True when the live index already expresses the definition we want.
 *
 * Upserting an unchanged definition makes the Search service reindex, and
 * queries fail with "pindex not available" while that runs. On a wiki of any
 * size that means every restart briefly breaks search, so the engine only
 * writes when something actually differs. The live definition carries defaults
 * the server filled in, so this is a subset test, not an equality test.
 */
function isIndexDefinitionCurrent (liveIndex, wantedDefinition) {
  if (!liveIndex || liveIndex.sourceName !== wantedDefinition.sourceName) {
    return false
  }
  return isDeepSubset(
    pruneDisabledFlags(wantedDefinition.params),
    pruneDisabledFlags(liveIndex.params)
  )
}

// Settings the engine cannot run without. Checked before activation so a bad
// or incomplete configuration is refused in the UI rather than failing later
// in the server log.
const REQUIRED_PROPS = [
  'connectionString',
  'username',
  'password',
  'bucketName',
  'scopeName',
  'collectionName',
  'indexName'
]

/**
 * Required settings that are still empty after environment fallbacks.
 */
function missingConfigKeys (config) {
  return REQUIRED_PROPS.filter(key => _.isEmpty(_.toString(config[key])))
}

/**
 * Deterministic document key. Lets update and delete be direct KV operations
 * and makes rename a delete plus an insert.
 */
function docKey (locale, path) {
  return `${locale}:${path}`
}

/**
 * Map a page into the document stored in Couchbase.
 *
 * `content` is the page's markdown source, stored verbatim rather than as the
 * flattened search string Wiki.js builds for its other engines. That string
 * joins every block with ' | ' and drops heading structure, which makes the
 * document impossible to chunk downstream. Keeping the markdown means a
 * consumer can split it on headings (/^#{1,6}\s/m) and on blank lines for
 * paragraphs, which is what a Couchbase Eventing function generating
 * embeddings needs.
 *
 * It is indexed but not stored in FTS: the GraphQL resolver rebuilds snippets
 * and section anchors from the rendered page in the primary database.
 */
function buildDoc ({ id, path, locale, title, description, tags, content }) {
  return {
    id,
    path,
    locale,
    title: title || '',
    description: description || '',
    tags: tags || [],
    content: content || ''
  }
}

const FIELD_BOOSTS = {
  title: 10,
  tags: 8,
  description: 3,
  content: 1
}

/**
 * Build the FTS query for a search.
 *
 * Field weighting is applied per clause: Couchbase FTS has no index-time
 * boost, unlike the Elasticsearch module's index mapping.
 *
 * The SDK module is injected so this stays unit-testable without loading the
 * native addon.
 */
function buildSearchQuery (couchbase, q, opts = {}) {
  const { SearchQuery } = couchbase
  const matches = _.map(FIELD_BOOSTS, (boost, field) =>
    SearchQuery.match(q).field(field).boost(boost)
  )
  const textQuery = SearchQuery.disjuncts(matches)

  const filters = []
  if (opts.locale) {
    filters.push(SearchQuery.term(opts.locale).field('locale'))
  }
  if (opts.path) {
    filters.push(SearchQuery.prefix(opts.path).field('path'))
  }
  if (filters.length < 1) {
    return textQuery
  }
  return SearchQuery.conjuncts([textQuery, ...filters])
}

/**
 * Fuzzy title query, used to offer suggestions when a search returns few hits.
 * FTS has no suggester, so this stands in for one.
 */
function buildSuggestQuery (couchbase, q) {
  return couchbase.SearchQuery.match(q).field('title').fuzziness(1)
}

/**
 * Keys present in the index but absent from the current page set.
 */
function staleKeys (existingKeys, currentKeys) {
  return existingKeys.filter(key => !currentKeys.has(key))
}

module.exports = {
  isIndexDefinitionCurrent,
  missingConfigKeys,
  resolveConfig,
  docKey,
  buildDoc,
  buildSearchQuery,
  buildSuggestQuery,
  staleKeys
}
