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

test('asset_text overrides the hover text when browsing (not mid-track)', () => {
  // Every alias in use is an album whose display text IS the album title, and
  // Discord paints large_text inside the now-playing card — so a PLAYING track
  // withholds it (see the no-album-name test below). Browsing still uses it.
  const activity = createPresenceActivity(HOME, {
    context: 'artist',
    artist_name: 'Playboi Carti',
    asset_key: 'album_safe_key',
    asset_text: 'The Real Album Title',
  })
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

// ---------------------------------------------------------------------------
// Member list line
//
// Collapsed in the member list, Discord shows ONE line next to the 🎵. It
// reads whichever field statusDisplayType points at, defaulting to the
// activity name — which is why every listener used to read "unreleased.world".
// ---------------------------------------------------------------------------

test('a playing track shows the ARTIST in the member list, not unreleased.world', () => {
  const activity = createPresenceActivity(HOME, playing())
  assert.equal(activity.statusDisplayType, 1) // STATE
  assert.equal(activity.state, 'playboi carti')
  // The expanded card header is unchanged.
  assert.equal(activity.name, 'unreleased.world')
  assert.equal(activity.details, 'Some Song')
})

test('the now-playing artist is always lowercase', () => {
  for (const [input, expected] of [
    ['Playboi Carti', 'playboi carti'],
    ['ken-carson', 'ken carson'],
    ['A$AP Rocky', 'a$ap rocky'],
    ['YEAT', 'yeat'],
  ]) {
    const activity = createPresenceActivity(HOME, playing({ artist_name: input }))
    assert.equal(activity.state, expected, `artist casing wrong for ${input}`)
  }
})

test('lowercasing applies to the ARTIST only — the track title keeps its casing', () => {
  const activity = createPresenceActivity(HOME, playing({
    track_title: 'Sky IS THE Limit',
    artist_name: 'Playboi Carti',
  }))
  assert.equal(activity.details, 'Sky IS THE Limit')
  assert.equal(activity.state, 'playboi carti')
  assert.equal(activity.name, 'unreleased.world')
})

test('the artist appears exactly ONCE — no stacked duplicate row', () => {
  // Regression: `largeImageText` already carried the artist from back when it
  // was the only place the artist showed. Adding `state` without clearing it
  // put the same name in two rendered fields, and Discord stacked them.
  for (const extra of [
    { album_name: 'Die Lit', is_single: false },
    { album_name: 'Some Song', is_single: true },
    {},
  ]) {
    const activity = createPresenceActivity(HOME, playing(extra))
    const shown = [activity.state, activity.details, activity.largeImageText]
    const artistCount = shown.filter((v) => v?.toLowerCase() === 'playboi carti').length
    assert.equal(artistCount, 1, `artist rendered ${artistCount}× for ${JSON.stringify(extra)}`)
  }
})

test('a playing track shows NO album name anywhere in the card', () => {
  // Discord draws large_text inside the now-playing card, not only on hover,
  // so the album name must not travel in it while a track is playing. The
  // album still selects the ART — it just is not printed.
  const cases = [
    // [payload, the art key the album should still select]
    [{ album_name: 'Die Lit', is_single: false }, 'album_die_lit'],
    [
      { album_name: 'Whole Lotta Red', is_single: false, asset_key: 'album_wlr', asset_text: 'Whole Lotta Red' },
      'album_wlr',
    ],
    // The shape that made this necessary: a real alias whose display text is
    // the album title (Discord refuses titles like this as asset names).
    [{ album_name: 'Forever, ILY', is_single: false, asset_text: 'Forever, ILY' }, 'album_forever_ily'],
  ]
  for (const [extra, expectedKey] of cases) {
    const activity = createPresenceActivity(HOME, playing(extra))
    const printed = [activity.details, activity.state, activity.largeImageText]
    assert.ok(
      !printed.includes(extra.album_name),
      `album name leaked for ${JSON.stringify(extra)} → ${JSON.stringify(printed)}`,
    )
    // The album still selects the ART — it just is not printed.
    assert.equal(activity.largeImageKey, expectedKey)
  }
})

test('a playing track carries no cover-art text at all', () => {
  assert.equal(createPresenceActivity(HOME, playing()).largeImageText, undefined)
})

test('a track with no artist keeps the old member-list text rather than going blank', () => {
  // Discord falls back to the activity name when the chosen field is empty,
  // so leaving statusDisplayType off here is what preserves today's behaviour.
  const activity = createPresenceActivity(HOME, {
    context: 'track',
    track_title: 'Some Song',
    is_playing: true,
  })
  assert.equal(activity.state, undefined)
  assert.equal(activity.statusDisplayType, undefined)
})

test('pausing leaves the member list exactly as it was before this change', () => {
  // Pausing already reclassified the presence to `artist` ("Browsing" + the
  // artist's art) long before the member-list line moved. That path is
  // deliberately untouched here — the artist name replaces "unreleased.world"
  // while a track is PLAYING, which is the only case that was asked for.
  const activity = createPresenceActivity(HOME, playing({ is_playing: false }))
  assert.equal(activity.statusDisplayType, undefined)
  assert.equal(activity.details, 'Browsing')
})

test('browsing still reads unreleased.world in the member list', () => {
  for (const payload of [{ context: 'browsing' }, { context: 'profile' }]) {
    const activity = createPresenceActivity(HOME, payload)
    assert.equal(activity.statusDisplayType, undefined, `${payload.context} changed`)
  }
})
