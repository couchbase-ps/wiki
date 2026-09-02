const _ = require('lodash')
const {
  resolveConfig, missingConfigKeys, isIndexDefinitionCurrent, docKey, buildDoc, buildSearchQuery, buildSuggestQuery, staleKeys
} = require('../../modules/search/couchbase/helpers')

// Minimal stand-in for the SDK's SearchQuery builders. Records what each
// clause was asked for, so the tests assert on intent rather than on the
// native addon, which cannot be loaded without a live cluster.
function stubCouchbase () {
  const clause = (kind, value) => {
    const node = { kind, value }
    node.field = f => { node._field = f; return node }
    node.boost = b => { node._boost = b; return node }
    node.fuzziness = f => { node._fuzziness = f; return node }
    return node
  }
  return {
    SearchQuery: {
      match: v => clause('match', v),
      term: v => clause('term', v),
      prefix: v => clause('prefix', v),
      disjuncts: (...qs) => ({ kind: 'disjuncts', children: qs.flat() }),
      conjuncts: (...qs) => ({ kind: 'conjuncts', children: qs.flat() })
    }
  }
}

describe('couchbase search helpers', () => {
  describe('resolveConfig', () => {
    it('falls back to env when the stored prop is empty', () => {
      const result = resolveConfig(
        { connectionString: '', username: '', bucketName: 'wiki' },
        { CB_CONNECTION_STRING: 'couchbase://cb', CB_USER: 'wiki' }
      )
      expect(result.connectionString).toBe('couchbase://cb')
      expect(result.username).toBe('wiki')
    })

    it('keeps the stored prop when it is set', () => {
      const result = resolveConfig(
        { connectionString: 'couchbase://stored' },
        { CB_CONNECTION_STRING: 'couchbase://env' }
      )
      expect(result.connectionString).toBe('couchbase://stored')
    })

    it('leaves a prop empty when neither source has a value', () => {
      const result = resolveConfig({ username: '' }, {})
      expect(result.username).toBe('')
    })

    it('does not mutate the config it was given', () => {
      const config = { username: '' }
      resolveConfig(config, { CB_USER: 'wiki' })
      expect(config.username).toBe('')
    })
  })

  describe('docKey', () => {
    it('joins locale and path with a colon', () => {
      expect(docKey('en', 'guides/setup')).toBe('en:guides/setup')
    })
  })

  describe('buildDoc', () => {
    it('maps a page into the indexed document shape', () => {
      const doc = buildDoc({
        id: 42,
        path: 'guides/setup',
        locale: 'en',
        title: 'Setup Guide',
        description: 'How to set things up',
        tags: ['ops', 'guide'],
        content: 'setup guide body text'
      })
      expect(doc).toEqual({
        id: 42,
        path: 'guides/setup',
        locale: 'en',
        title: 'Setup Guide',
        description: 'How to set things up',
        tags: ['ops', 'guide'],
        content: 'setup guide body text'
      })
    })

    it('defaults missing description and tags rather than emitting undefined', () => {
      const doc = buildDoc({
        id: 1,
        path: 'home',
        locale: 'en',
        title: 'Home',
        content: 'body'
      })
      expect(doc.description).toBe('')
      expect(doc.tags).toEqual([])
    })
  })

  describe('buildSearchQuery', () => {
    it('weights title, tags, description and content', () => {
      const query = buildSearchQuery(stubCouchbase(), 'couchbase', {})
      const boosts = Object.fromEntries(query.children.map(c => [c._field, c._boost]))
      expect(boosts).toEqual({
        title: 10,
        tags: 8,
        description: 3,
        content: 1
      })
    })

    it('returns a bare disjunction when no filters are requested', () => {
      const query = buildSearchQuery(stubCouchbase(), 'couchbase', {})
      expect(query.kind).toBe('disjuncts')
    })

    it('adds a locale term filter when a locale is requested', () => {
      const query = buildSearchQuery(stubCouchbase(), 'couchbase', { locale: 'en' })
      expect(query.kind).toBe('conjuncts')
      const localeClause = query.children.find(c => c._field === 'locale')
      expect(localeClause.kind).toBe('term')
      expect(localeClause.value).toBe('en')
    })

    it('adds a path prefix filter when a path is requested', () => {
      const query = buildSearchQuery(stubCouchbase(), 'couchbase', { path: 'guides' })
      const pathClause = query.children.find(c => c._field === 'path')
      expect(pathClause.kind).toBe('prefix')
      expect(pathClause.value).toBe('guides')
    })

    it('keeps the weighted text query alongside the filters', () => {
      const query = buildSearchQuery(stubCouchbase(), 'couchbase', { locale: 'en', path: 'guides' })
      expect(query.children).toHaveLength(3)
      expect(query.children[0].kind).toBe('disjuncts')
    })
  })

  describe('buildSuggestQuery', () => {
    it('is a fuzzy match on the title field', () => {
      const query = buildSuggestQuery(stubCouchbase(), 'couchbse')
      expect(query.kind).toBe('match')
      expect(query._field).toBe('title')
      expect(query._fuzziness).toBe(1)
    })
  })

  describe('staleKeys', () => {
    it('returns keys held in the index but absent from the current page set', () => {
      const result = staleKeys(
        ['en:home', 'en:gone', 'fr:accueil'],
        new Set(['en:home', 'fr:accueil'])
      )
      expect(result).toEqual(['en:gone'])
    })

    it('returns an empty array when nothing is stale', () => {
      expect(staleKeys(['en:home'], new Set(['en:home']))).toEqual([])
    })

    it('treats an empty current set as making everything stale', () => {
      expect(staleKeys(['en:home', 'en:other'], new Set())).toEqual(['en:home', 'en:other'])
    })
  })

  describe('missingConfigKeys', () => {
    const complete = {
      connectionString: 'couchbase://cb',
      username: 'wiki',
      password: 'secret',
      bucketName: 'wiki',
      scopeName: 'search',
      collectionName: 'pages',
      indexName: 'wiki-pages-fts'
    }

    it('returns nothing when every required setting is present', () => {
      expect(missingConfigKeys(complete)).toEqual([])
    })

    it('reports each empty required setting', () => {
      expect(missingConfigKeys({ ...complete, password: '', indexName: '' }))
        .toEqual(['password', 'indexName'])
    })

    it('reports settings that are absent entirely', () => {
      expect(missingConfigKeys({})).toEqual([
        'connectionString', 'username', 'password',
        'bucketName', 'scopeName', 'collectionName', 'indexName'
      ])
    })

    it('ignores optional settings', () => {
      expect(missingConfigKeys({ ...complete, maxResults: 0, verifyTLSCertificate: false })).toEqual([])
    })
  })

  describe('isIndexDefinitionCurrent', () => {
    const wanted = {
      sourceName: 'wiki',
      params: {
        doc_config: { mode: 'scope.collection.type_field', type_field: 'type' },
        mapping: {
          types: {
            'search.pages': {
              dynamic: false,
              enabled: true,
              properties: {
                title: { fields: [{ name: 'title', type: 'text', index: true, store: false, docvalues: false }] }
              }
            }
          }
        }
      }
    }

    it('treats a definition the server stripped of false flags as current', () => {
      // The Search service drops false-valued flags, so these come back absent.
      const live = {
        sourceName: 'wiki',
        params: {
          doc_config: { mode: 'scope.collection.type_field', type_field: 'type', docid_prefix_delim: '', docid_regexp: '' },
          mapping: {
            types: {
              'search.pages': {
                enabled: true,
                properties: {
                  title: { fields: [{ name: 'title', type: 'text', index: true }] }
                }
              }
            }
          }
        }
      }
      expect(isIndexDefinitionCurrent(live, wanted)).toBe(true)
    })

    it('detects a field setting that conflicts with the one we want', () => {
      const live = _.cloneDeep(wanted)
      live.params.mapping.types['search.pages'].properties.title.fields[0].type = 'number'
      expect(isIndexDefinitionCurrent(live, wanted)).toBe(false)
    })

    it('detects an indexed field the live index has turned off', () => {
      const live = _.cloneDeep(wanted)
      live.params.mapping.types['search.pages'].properties.title.fields[0].index = false
      expect(isIndexDefinitionCurrent(live, wanted)).toBe(false)
    })

    it('ignores extra settings the server added on its own', () => {
      const live = _.cloneDeep(wanted)
      live.params.mapping.types['search.pages'].properties.title.fields[0].analyzer = 'standard'
      live.params.mapping.default_analyzer = 'standard'
      expect(isIndexDefinitionCurrent(live, wanted)).toBe(true)
    })

    it('detects a field the live index is missing', () => {
      const live = _.cloneDeep(wanted)
      delete live.params.mapping.types['search.pages'].properties.title
      expect(isIndexDefinitionCurrent(live, wanted)).toBe(false)
    })

    it('detects a different source bucket', () => {
      expect(isIndexDefinitionCurrent({ ...wanted, sourceName: 'other' }, wanted)).toBe(false)
    })

    it('is false when the index does not exist', () => {
      expect(isIndexDefinitionCurrent(null, wanted)).toBe(false)
    })
  })
})
