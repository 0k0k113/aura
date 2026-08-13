// tests/presence.test.js
//
// Covers Discord activity construction:
//   • THE GATE — a card exists only while a track is playing; everything else
//     builds nothing at all, which the caller turns into clearActivity()
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

test('a playing track with no duration still gets a start timestamp', () => {
  const activity = createPresenceActivity(HOME, playing({ duration_ms: undefined }))
  assert.ok(activity.startTimestamp > 0)
  assert.equal(activity.endTimestamp, undefined)
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

test('the album is NEVER in large_text — that is what draws the unwanted line', () => {
  // Discord documents large_text as the large image's hover tooltip, and both
  // the official and reverse-engineered docs say so. This client disagrees: it
  // ALSO paints large_text as a line between the track title and the artist.
  // Whatever it is called, nothing may travel in it.
  const cases = [
    { album_name: 'Die Lit', is_single: false },
    { album_name: 'Whole Lotta Red', is_single: false, asset_key: 'album_wlr', asset_text: 'Whole Lotta Red' },
    { album_name: 'Forever, ILY', is_single: false, asset_text: 'Forever, ILY' },
    {},
  ]
  for (const extra of cases) {
    const activity = createPresenceActivity(HOME, playing(extra))
    assert.equal(activity.largeImageText, undefined, `large_text set for ${JSON.stringify(extra)}`)
  }
})

test('the album rides on small_text instead, so it hovers without a line', () => {
  // small_text is a separate field with its own hover target (the small image)
  // and has never been part of any card line layout.
  const cases = [
    [{ album_name: 'Die Lit', is_single: false }, 'Die Lit', 'album_die_lit'],
    [
      { album_name: 'Whole Lotta Red', is_single: false, asset_key: 'album_wlr', asset_text: 'Whole Lotta Red' },
      'Whole Lotta Red',
      'album_wlr',
    ],
    // An alias's display text is the real title Discord refused as a key.
    [
      { album_name: 'if looks could kill (directors cut)', is_single: false, asset_key: 'album_ilckd', asset_text: 'If Looks Could Kill (Directors Cut)' },
      'If Looks Could Kill (Directors Cut)',
      'album_ilckd',
    ],
  ]
  for (const [extra, expectedHover, expectedKey] of cases) {
    const activity = createPresenceActivity(HOME, playing(extra))
    assert.equal(activity.smallImageText, expectedHover, `hover wrong for ${JSON.stringify(extra)}`)
    // The badge has to exist or there is nothing to hover.
    assert.equal(activity.smallImageKey, FALLBACK)
    // The large image is still the album art.
    assert.equal(activity.largeImageKey, expectedKey)
    // And the album is still absent from every printed line.
    assert.ok(![activity.details, activity.state].includes(extra.album_name))
  }
})

test('a single gets no badge and no hover text', () => {
  // Its "album" is the track title, already printed directly above.
  for (const extra of [
    { album_name: 'Some Song', is_single: true },
    { album_name: 'Some Song' },
    { album_name: 'Whatever', album_type: 'Single' },
    { album_name: 'Whatever', album_tracks_count: 1 },
    {},
  ]) {
    const activity = createPresenceActivity(HOME, playing(extra))
    assert.equal(activity.smallImageText, undefined, `hover text for ${JSON.stringify(extra)}`)
    assert.equal(activity.smallImageKey, undefined, `badge for ${JSON.stringify(extra)}`)
  }
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

// ---------------------------------------------------------------------------
// The gate: a card exists ONLY while a track is playing.
//
// `null` is the "show nothing" signal. main.ts answers it with
// clearActivity() — see the contract note in presence.ts. Every case below
// used to render a "Browsing" card instead.
// ---------------------------------------------------------------------------

test('PAUSING shows nothing at all', () => {
  assert.equal(createPresenceActivity(HOME, playing({ is_playing: false })), null)
})

test('pausing shows nothing however much metadata the payload carries', () => {
  const cases = [
    { album_name: 'Die Lit', is_single: false },
    { album_name: 'Whole Lotta Red', asset_key: 'album_wlr', asset_text: 'Whole Lotta Red' },
    { position_ms: 0 },
    { position_ms: 179_000, duration_ms: 180_000 }, // a track running out
    {},
  ]
  for (const extra of cases) {
    const activity = createPresenceActivity(HOME, playing({ ...extra, is_playing: false }))
    assert.equal(activity, null, `paused card rendered for ${JSON.stringify(extra)}`)
  }
})

test('browsing, artist pages and profiles all show nothing', () => {
  const payloads = [
    { context: 'browsing' },
    { context: 'browsing', details: 'Browsing' },
    { context: 'artist', artist_name: 'Playboi Carti' },
    { context: 'artist', artist_name: 'Playboi Carti', asset_key: 'artist_carti_alt' },
    { context: 'profile' },
    { context: 'profile', deep_link: 'https://unreleased.world/profiles/someone' },
  ]
  for (const payload of payloads) {
    assert.equal(
      createPresenceActivity(HOME, payload),
      null,
      `${payload.context} still rendered a card`,
    )
  }
})

test('an artist-page URL alone shows nothing', () => {
  // The URL used to supply a whole "Browsing" card by itself, with no payload.
  assert.equal(createPresenceActivity('https://unreleased.world/artist/playboi-carti'), null)
  assert.equal(createPresenceActivity(HOME), null)
  assert.equal(createPresenceActivity(HOME, {}), null)
})

test('a payload that never says is_playing shows nothing', () => {
  // `!== true`, not `=== false`: browsing payloads omit the field entirely.
  const activity = createPresenceActivity(HOME, {
    context: 'track',
    track_title: 'Some Song',
    artist_name: 'Playboi Carti',
  })
  assert.equal(activity, null)
})

test('a "playing" payload with no metadata shows nothing rather than an empty card', () => {
  assert.equal(createPresenceActivity(HOME, { context: 'track', is_playing: true }), null)
  // Even on an artist page, where the URL could have supplied a name.
  assert.equal(
    createPresenceActivity('https://unreleased.world/artist/playboi-carti', {
      context: 'track',
      is_playing: true,
    }),
    null,
  )
})

test('the card comes back exactly as before when playback resumes', () => {
  const paused = createPresenceActivity(HOME, playing({ is_playing: false }))
  const resumed = createPresenceActivity(HOME, playing())

  assert.equal(paused, null)
  assert.equal(resumed.details, 'Some Song')
  assert.equal(resumed.state, 'playboi carti')
  assert.equal(resumed.statusDisplayType, 1)
  assert.ok(resumed.startTimestamp > 0)
})

test('browsing mid-song does not rename the artist to the page you are on', () => {
  // The card must describe what is PLAYING, not what is on screen: the display
  // name comes from the payload, while only the art may fall back to the URL.
  const activity = createPresenceActivity('https://unreleased.world/artist/ken-carson', playing())
  assert.equal(activity.state, 'playboi carti')
})
