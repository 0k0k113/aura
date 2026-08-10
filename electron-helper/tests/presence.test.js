// tests/presence.test.js
//
// Covers Discord activity construction, with emphasis on art selection:
//   • alias-resolved asset keys win over derived ones
//   • single vs album classification (broken while main.ts's zod schema was
//     silently stripping is_single / album_type / album_tracks_count)

const test = require('node:test')
const assert = require('node:assert/strict')

const { createPresenceActivity } = require('../dist/presence')

const HOME = 'https://unreleased.world/home'
const FALLBACK = 'unreleasd_logo'

/** Minimal "now playing" payload. */
function playing(extra = {}) {
  return {
    context: 'track',
    track_title: 'Some Song',
    artist_name: 'Playboi Carti',
    is_playing: true,
    position_ms: 30_000,
    duration_ms: 180_000,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

test('an alias-resolved asset_key overrides the derived key', () => {
  const activity = createPresenceActivity(HOME, playing({
    album_name: 'Whole Lotta Red',
    is_single: false,
    asset_key: 'album_wlr_2020',
  }))
  assert.equal(activity.largeImageKey, 'album_wlr_2020')
})

test('asset_key wins for artist browsing too', () => {
  const activity = createPresenceActivity(HOME, {
    context: 'artist',
    artist_name: 'Playboi Carti',
    asset_key: 'artist_carti_alt',
  })
  assert.equal(activity.largeImageKey, 'artist_carti_alt')
})

test('asset_text overrides the hover text', () => {
  const activity = createPresenceActivity(HOME, playing({
    asset_key: 'album_safe_key',
    asset_text: 'The Real Album Title',
  }))
  assert.equal(activity.largeImageText, 'The Real Album Title')
})

test('an asset_key Discord would reject is ignored, not forwarded', () => {
  // Discord asset names are [a-z0-9_-], max 32. Sending anything else renders
  // no art at all, so a bad key must fall back to the derived one.
  for (const bad of [
    'Album With Spaces',
    'album/with/slashes',
    'ALBUM_UPPER_ONLY!',
    'a'.repeat(33),
    '',
    '   ',
  ]) {
    const activity = createPresenceActivity(HOME, playing({
      album_name: 'Whole Lotta Red',
      is_single: false,
      asset_key: bad,
    }))
    assert.equal(activity.largeImageKey, 'album_whole_lotta_red', `bad key leaked: ${JSON.stringify(bad)}`)
  }
})

test('an uppercase asset_key is normalized rather than dropped', () => {
  const activity = createPresenceActivity(HOME, playing({ asset_key: 'Album_WLR_2020' }))
  assert.equal(activity.largeImageKey, 'album_wlr_2020')
})

// ---------------------------------------------------------------------------
// Single vs album art — the fields main.ts used to strip
// ---------------------------------------------------------------------------

test('is_single:true uses the artist image', () => {
  const activity = createPresenceActivity(HOME, playing({
    album_name: 'Some Song',
    is_single: true,
  }))
  assert.equal(activity.largeImageKey, 'artist_playboi_carti')
})

test('is_single:false uses the album image', () => {
  const activity = createPresenceActivity(HOME, playing({
    album_name: 'Die Lit',
    is_single: false,
  }))
  assert.equal(activity.largeImageKey, 'album_die_lit')
})

test('album_type "single" is honoured', () => {
  const activity = createPresenceActivity(HOME, playing({
    album_name: 'Whatever',
    album_type: 'Single',
  }))
  assert.equal(activity.largeImageKey, 'artist_playboi_carti')
})

test('album_tracks_count 1 is treated as a single', () => {
  const activity = createPresenceActivity(HOME, playing({
    album_name: 'Whatever',
    album_tracks_count: 1,
  }))
  assert.equal(activity.largeImageKey, 'artist_playboi_carti')
})

test('an album whose title equals the track title is treated as a single', () => {
  const activity = createPresenceActivity(HOME, playing({ album_name: 'some song' }))
  assert.equal(activity.largeImageKey, 'artist_playboi_carti')
})

test('explicit is_single beats the title-equality heuristic', () => {
  const activity = createPresenceActivity(HOME, playing({
    album_name: 'Some Song',
    is_single: false,
  }))
  assert.equal(activity.largeImageKey, 'album_some_song')
})

// ---------------------------------------------------------------------------
// Slugging + fallbacks
// ---------------------------------------------------------------------------

test('special characters are transliterated into a valid Discord key', () => {
  const activity = createPresenceActivity(HOME, playing({
    artist_name: 'A$AP Rocky',
    album_name: 'Testing & More',
    is_single: false,
  }))
  assert.equal(activity.largeImageKey, 'album_testing_and_more')
  assert.match(activity.largeImageKey, /^[a-z0-9_-]+$/)
})

test('every derived key is a legal Discord asset name', () => {
  const names = ['Playboi Carti', 'A$AP Rocky', 'Ken Carson!!!', '☆☆☆', 'Yeat  —  2093']
  for (const artist_name of names) {
    const activity = createPresenceActivity(HOME, playing({ artist_name, is_single: true }))
    assert.match(activity.largeImageKey, /^[a-z0-9_-]+$/, `illegal key for ${artist_name}`)
    assert.ok(activity.largeImageKey.length <= 32, `key too long for ${artist_name}`)
  }
})

test('a name that slugs to nothing falls back to the logo', () => {
  const activity = createPresenceActivity(HOME, playing({ artist_name: '☆☆☆', is_single: true }))
  assert.equal(activity.largeImageKey, FALLBACK)
})

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test('a playing track carries start and end timestamps', () => {
  const activity = createPresenceActivity(HOME, playing())
  assert.ok(activity.startTimestamp > 0)
  assert.ok(activity.endTimestamp > activity.startTimestamp)
})

test('a paused track carries no timestamps', () => {
  const activity = createPresenceActivity(HOME, {
    context: 'track',
    track_title: 'Some Song',
    artist_name: 'Playboi Carti',
    is_playing: false,
    position_ms: 30_000,
    duration_ms: 180_000,
  })
  assert.equal(activity.startTimestamp, undefined)
  assert.equal(activity.endTimestamp, undefined)
})

test('browsing uses the logo and no timer', () => {
  const activity = createPresenceActivity(HOME, { context: 'browsing' })
  assert.equal(activity.largeImageKey, FALLBACK)
  assert.equal(activity.details, 'Browsing')
  assert.equal(activity.startTimestamp, undefined)
})

test('activity is always reported as Listening to unreleased.world', () => {
  const activity = createPresenceActivity(HOME, playing())
  assert.equal(activity.name, 'unreleased.world')
  assert.equal(activity.type, 2)
})
