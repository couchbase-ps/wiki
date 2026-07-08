#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const { parseWikiignore, createPageMatcher } = require('./lib/match-ignored')

const API_URL = process.env.WIKI_GRAPHQL_URL
const API_KEY = process.env.WIKI_API_KEY

function parseArgs (argv) {
  const args = { wikiignore: '.wikiignore', apply: false, reimport: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') { args.apply = true } else if (a === '--reimport') { args.reimport = true } else if (a === '--wikiignore') { args.wikiignore = argv[++i] } else { console.error(`Unknown arg: ${a}`); process.exit(2) }
  }
  return args
}

async function gql (query, variables) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ query, variables })
  })
  const json = await res.json()
  if (json.errors) { throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`) }
  return json.data
}

const LIST_QUERY = 'query { pages { list(orderBy: PATH) { id path locale title } } }'
const DELETE_MUTATION = `mutation ($id: Int!) {
  pages { delete(id: $id) { responseResult { succeeded errorCode message } } }
}`
const LIST_TARGETS = 'query { storage { targets { key isEnabled } } }'
const EXEC_ACTION = `mutation ($targetKey: String!, $handler: String!) {
  storage { executeAction(targetKey: $targetKey, handler: $handler) {
    responseResult { succeeded errorCode message } } }
}`

async function main () {
  if (!API_URL || !API_KEY) {
    console.error('Set WIKI_GRAPHQL_URL and WIKI_API_KEY env vars.')
    process.exit(2)
  }
  const args = parseArgs(process.argv)
  const content = fs.readFileSync(path.resolve(args.wikiignore), 'utf8')
  const parsed = parseWikiignore(content)
  if (parsed.unsupported.length) {
    console.warn('WARNING: these .wikiignore patterns are NOT honored by the cleanup matcher — pages matching them will NOT be deleted; handle them manually:')
    for (const u of parsed.unsupported) { console.warn(`  ${u}`) }
  }
  const isIgnored = createPageMatcher(content)

  const data = await gql(LIST_QUERY)
  const pages = data.pages.list
  const matched = pages.filter(p => isIgnored(p.path))

  console.log(`Total pages: ${pages.length}`)
  console.log(`Matched as internal: ${matched.length}`)
  for (const p of matched.slice(0, 50)) { console.log(`  [${p.id}] ${p.path}`) }
  if (matched.length > 50) { console.log(`  … ${matched.length - 50} more`) }

  if (!args.apply) {
    console.log('\nDRY RUN — no pages deleted. Re-run with --apply to delete.')
    return
  }

  // deletePage removes the DB row (and search index + tree) BEFORE running the
  // git storage hook, so a storage-side failure (e.g. `git rm` path mismatch for
  // dot-prefixed dirs like `.github`) does NOT mean the page survived. Record and
  // continue; the post-run re-list below is the source of truth for what remains.
  let deleted = 0
  const failures = []
  for (const p of matched) {
    try {
      const r = await gql(DELETE_MUTATION, { id: p.id })
      const rr = r.pages.delete.responseResult
      if (!rr.succeeded) { throw new Error(rr.message || `errorCode ${rr.errorCode}`) }
      deleted++
    } catch (err) {
      failures.push({ path: p.path, message: String(err.message || err) })
    }
  }
  console.log(`Delete attempts: ${matched.length} — reported success ${deleted}, reported failure ${failures.length}`)
  if (failures.length) {
    console.log('Reported failures (DB row is typically already deleted; only the git step failed):')
    for (const f of failures.slice(0, 20)) { console.log(`  ${f.path}: ${f.message}`) }
    if (failures.length > 20) { console.log(`  … ${failures.length - 20} more`) }
  }

  // Re-list to report what actually remains (truth, independent of per-page status).
  const after = (await gql(LIST_QUERY)).pages.list.filter(pg => isIgnored(pg.path))
  console.log(`Internal pages still present after delete: ${after.length}`)

  if (args.reimport) {
    const t = await gql(LIST_TARGETS)
    const git = t.storage.targets.find(x => x.key === 'git')
    if (!git) { throw new Error('No "git" storage target found.') }
    const r = await gql(EXEC_ACTION, { targetKey: 'git', handler: 'importAll' })
    const rr = r.storage.executeAction.responseResult
    if (!rr.succeeded) { throw new Error(`importAll failed: ${rr.message}`) }
    console.log('Triggered importAll on git storage target.')
  }
}

main().catch(err => { console.error(err); process.exit(1) })
