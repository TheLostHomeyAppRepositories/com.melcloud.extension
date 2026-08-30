# CLAUDE.md

Homey app extending com.melcloud with automatic cooling adjustment based
on an outdoor temperature source. ESM only, Node >= 22.19. It talks to
the MELCloud devices exclusively through the local Homey API (`homey-api`)
— device behavior is fixed in com.melcloud (sibling repo with its own
CLAUDE.md), never worked around here.

## Inter-app API dependency

This app has no npm dependency on the MELCloud stack — its real
dependency is WIRE-LEVEL, against whatever com.melcloud version is
installed alongside, and it is one-directional (com.melcloud never calls
back). The consumed surface, exhaustively:

- The app ids themselves carry the original submissions' typo, and it
  is LOAD-BEARING: this app is `com.mecloud.extension` and addresses
  the main app as `com.mecloud` (`MELCLOUD_APP_ID`, `app.mts`). A
  platform id cannot change without orphaning every install, so the
  store URLs keep the typo too (`https://homey.app/a/com.mecloud`,
  `https://homey.app/a/com.mecloud.extension`). Never "fix" the
  missing `l` anywhere — manifest, code or docs links (a README "fix"
  once turned all three store links into 404s; reverted, 2026-08).

- `GET /devices/groups` on com.melcloud's app API — the building
  grouping. The contract is DEGRADE, never fail: an absent route (older
  com.melcloud, app not installed) or an off-shape payload reads as "no
  grouping" (`to-device-groups.mts` sanitizes; the settings page falls
  back to one flat group). Never assume the route exists.
- The MELCloud devices themselves through `homey-api`
  (`HomeyAPIV3Local`): driver ids (`melcloud`, `home-melcloud`),
  capability ids (`target_temperature`, `thermostat_mode`,
  `measure_temperature`*), and `device.data.id` as the join key between
  Homey devices and `/devices/groups` entries — Classic serializes a
  NUMBER as string, Home a GUID, which is why joins go through
  `toJoinKey` (`group-devices.mts`) and nothing else; #1229 was exactly
  a join done another way.
- Per-device failures are reported and skipped (`#listenToDevice`), so
  one renamed capability cannot take the whole adjustment down.

Changing any of these on the com.melcloud side is a cross-repo change:
check this app the way byte-identical kernels are checked. The exact-pin
rule of the npm consumers has no equivalent here — the wire tolerates
version skew by design, which is why every consumed shape is sanitized
at entry.

## Commands

Run the FULL suite before any push — CI runs all of it:

- `npm run format` / `npm run format:fix` — prettier (eslint does NOT
  cover formatting).
- `npm run lint` / `npm run lint:fix` — ESLint (also lints CSS, HTML,
  JSON, YAML and Markdown via the language plugins).
- `npm run typecheck` — the native TypeScript 7 compiler, reached by
  its explicit path, `node ./node_modules/@typescript/native/bin/tsc`
  (`build` spells out the same path). Keep the path explicit: the
  native package ships no `.bin` shim, and the `tsc` and `tsc6` shims
  that do exist come from the compat package `@typescript/typescript6`
  and run TypeScript 6 — a bare `tsc` would silently typecheck on the
  wrong compiler.
- `npm test` / `npm run test:coverage` — vitest; backend coverage is at
  100% (branches included), keep it there. `settings/` is browser glue
  and excluded.
- `npm run build` — esbuild bundle (`scripts/bundle.mts`) + `tsc`
  emit, BOTH into `.homeybuild`. The Homey CLI runs `npm run build`
  when it detects TypeScript — but only AFTER its pre-process copy into
  `.homeybuild`, so the source tree stays sources-only and everything
  the package needs must be emitted there: tsc does it via `outDir`,
  and `bundle.mts` emits the settings bundles there too (its former
  source-tree outfiles landed too late to be copied — the com.melcloud
  #1404 root cause: store installs 404'd the bundles). The CLI's own
  build invocation is therefore sufficient for install, run, validate
  and publish alike; a standalone suite run (no `.homeybuild` page
  copy) still proves the bundles compile.
- Cache-busting `?v=` — a PACKAGE-TIME transform: `bundle.mts` stamps
  every local asset reference of the `.homeybuild` page copy with a
  content hash (`?v=<hash>`), so phone webviews (which cache assets
  across app versions) refetch an asset exactly when its bytes change.
  The committed source HTML carries NO stamps — never hand-add a `?v=`
  there, and nothing needs re-committing when a settings source changes
  (the old re-stamp-and-commit dance is gone). Stamps exist only in the
  packaged app, within attribute/import reference contexts
  (`href="`/`src="`) — matched WHEREVER they appear, HTML comments
  included: a commented reference to a missing file fails the packaging
  pass, and one to a real file would be stamped by the builder yet
  invisible to the page-side DOM query, splitting the two identities
  into an endless refetch handshake. Delete a dead reference, never
  comment it out.
- `npm run homey:validate` — Homey validation at publish level; may
  rewrite files (locales), re-stage if it does.
- `npm run homey:start` — `homey app run --remote` for on-device testing.

Check real exit codes; never pipe a check's output through `tail`/`grep`
to judge success.

## Architecture

- `app.mts` — discovers the MELCloud AC devices (`ATA_DRIVER_IDS`
  matches BOTH dialects: Classic `melcloud` and MELCloud Home
  `home-melcloud`; the app id `com.mecloud` is a historical typo) and
  the temperature sensors, debounces device events, and owns the
  per-device `MELCloudListener`s plus the shared `OutdoorSource`
  registry.
- Device grouping — com.melcloud exposes `GET /devices/groups`
  (`[{ deviceIds, name }]`, one entry per MELCloud building, both
  dialects, sorted by name). The extension declares the
  `homey:app:com.mecloud` permission and calls the endpoint through
  `this.homey.api.getApiApp('com.mecloud')` when (re)loading devices.
  Any failure or off-shape payload (com.melcloud missing or too old)
  reads as "no grouping" (`null`, sanitized by
  `lib/to-device-groups.mts`) and the settings fall back to one row
  per device. The join key is `String(device.data.id)` — the MELCloud
  id com.melcloud writes at pairing (Classic numeric DeviceID, Home
  uuid); same-name buildings across dialects merge into one group and
  unmatched devices trail in an unnamed group
  (`lib/group-devices.mts`). The settings UI renders ONE select per
  building and fans the pick out to every device of the group before
  the PUT; storage stays per device (`outdoorSources`), listeners
  unchanged.
- `listeners/` — instance-based. Each `MELCloudListener` is bound to an
  `OutdoorSource` (per-device setting): `CapabilityOutdoorSource` (a
  "deviceId:capabilityId" path watched through a capability instance) or
  the shared `WeatherOutdoorSource` default. Sources hold their cooling
  subscribers: watching starts with the first `attach` (single-flight —
  concurrent attaches await one start) and stops with the last `detach`.
  melcloud.mts only imports the source as a type — no runtime cycle.
- `settings/index.mts` — browser-side settings UI, bundled by esbuild
  into `settings/index.js` as a CLASSIC IIFE (`format: 'iife'`,
  `globalName: MELCloudWebview`), loaded via `<script defer src>` — NOT
  an ES module (mirrors com.melcloud). Only the JS module loader fails:
  `import()` / `<script type=module>` stall on a COLD webview open
  against Homey's local origin (the #1404 spinner), while classic
  resource fetches — the stylesheet, a classic `<script src>` — load
  cold. The HTML declares the docs' canonical global
  `function onHomeyReady(homey)` inline (it must exist at parse time),
  which polls `globalThis.MELCloudWebview` and calls its `start(homey)`.
  `defer` (as in com.melcloud) is the right fit for an app bundle that
  reads the DOM — ordered, after `<body>` parses, before
  DOMContentLoaded — and here it is doubly required: this entry does DOM
  lookups at module top level, which `defer` makes safe. The poll's 10 s
  timeout still ends the overlay if the script failed to load. Init work is separately
  time-bounded (10 s) with `homey.ready()` in a `finally`; `start` is
  non-throwing by construction (failure alerts go through
  `fireAndForget`). `scripts/bundle.mts` stamps every local asset
  reference — only inside an attribute/import context, never a comment —
  with a content hash (`?v=`): phone webviews cache assets across app
  versions. Never load the bundle as a STATIC `<script type=module>`:
  it stalls the whole boot on a cold open (shipped and reverted in
  com.melcloud, proven on-device there). Dynamic `import()` is merely
  unnecessary, not broken — its supposed Android fetch failures were
  com.melcloud #1404's missing-bundle 404s — but do not churn the
  loading mechanism without new on-device evidence: classic `defer`
  carries the bounded boot plus beacon. Phone webviews also cache the
  HTML ITSELF across
  app versions (proven on com.melcloud), so shipped bundle filenames are
  a COMPAT CONTRACT: `scripts/bundle.mts` builds the entry twice —
  `index.js` (IIFE) for the current HTML, `index.mjs` (ESM) for every
  cached ESM-era HTML, which is why the entry keeps `export const
start`. Never rename or drop a shipped bundle filename; add alongside. A second cache layer covers the HTML
  itself (phone webviews cache the page across app versions,
  force-close included): each bundle carries a freshness handshake —
  the page's identity is the document-order join of its `?v=` stamps (a CSS-only ship moves it too), `GET /webview-hashes` serves the
  live hashes (a manifest `bundle.mts` emits into the packaged app,
  read by `@olivierzal/homey-kit/node`; `api.mts` passes the manifest
  URL explicitly — the kit's default resolves against its own module,
  which lives in `node_modules`), and a mismatch triggers ONE
  refetch of the document through a never-cached address
  (`?fresh=<identity>` — a bare reload can be re-served the same stale
  document from the HTTP cache; sessionStorage guard,
  `watchWebviewFreshness` from `@olivierzal/homey-kit/webview`), whose
  fresh stamps pull the fresh assets;
  a mismatch that survives its refetch is reported to
  `POST /boot-error`. The guarantee lives in the BOOT check, and which
  surface needs it was measured on device (2026-08-07): the web-app
  settings page is destroyed and REMOUNTED when the app restarts, and
  mobile widgets reload too — both are fresh for free. Only the mobile
  settings page survives an app restart, so it alone never boots again;
  that is why the watcher re-checks on RETURN TO THE FOREGROUND
  (`visibilitychange`), the trigger that covers it. The app also emits a
  `webview_hashes_changed` realtime event at its own boot and the page
  subscribes to it, but it guarantees NOTHING on its own: it fires at
  the end of the app's `onInit`, i.e. exactly when the restart has just
  disconnected every open page, so its audience is absent by
  construction (measured: an open mobile page produced no request and no
  breadcrumb). Never fold the visibility trigger into it. Every failure
  path stays open: an unstamped page, an absent route or denied
  storage must never take a working webview down.
  When the bundle still fails to boot, the `onHomeyReady` poll's timeout
  beacon POSTs the `userAgent` plus a `fetch` probe of the bundle to
  `/boot-error` (`app.error`) before degrading, distinguishing a fetch
  failure from a parse-or-runtime crash (pre-es2020 engines). Webview
  runtime-API floor: es2023 array methods are accepted
  (`toSorted`/`toReversed` ship today), but nothing newer — no iterator
  helpers (`.entries().map()`, 2025-era): esbuild lowers syntax only. Settings pages and
  widgets do NOT style the same way: settings follow the Homey Style
  Library (`homey-form-*`/`homey-button-*`; in a `homey-form-group` the
  control is a SIBLING after its label — see
  custom-views/html-and-css-styling in the Homey docs), while widgets
  get injected CSS variables and their own class set. Do not copy
  markup across the two, nor from com.melcloud's settings (which nest
  controls inside labels).
- `homey-api-override.d.ts` — ambient module declaration for the
  homey-api surface actually used; `homey-override.d.ts` types the app
  settings. `lib/homey.mts` re-exports the runtime-provided `homey` SDK
  (the scoped eslint carve-out for `import-x/no-extraneous-dependencies`
  lives there, not inline).

## Platform gotchas

- `.homeycompose/` is the SOURCE for `app.json` and `locales/*.json`;
  commit the CLI-generated outputs verbatim (no trailing newline).
- App-API surface conventions (aligned on com.melcloud): paths are
  kebab-case REST, `get*` for GET — except `is*` for a boolean GET —,
  `update*` for PUT, a business verb for POST (`logWebviewBoot` on
  `/boot-error`); `fetch*` in the webview is reserved
  for transport calls (`load*` reads the settings store). The
  auto-adjustment path is `/cooling/auto-adjustment` (the snake_case
  legacy alias was dropped by decision, 2026-07 — a cached pre-rename
  bundle now alerts on Apply until it refreshes). The com.melcloud
  grouping is `GET /devices/groups` only; an older com.melcloud reads
  as "no grouping" (the sanitizer's degradation path).
  `@olivierzal/homey-kit/settings` is the settings page's transport
  (error-first-callback SDK). The surface
  is test-pinned in two halves, one file each — extend BOTH when
  touching a route: `tests/unit/api-contract.test.ts` pins manifest
  ids ↔ handlers both ways plus the handlers' function type;
  `tests/unit/api-route-guards.test.ts` pins the call sites (every
  settings path literal must match a declared route). Both are now the
  kit's table-driven kernels: each file holds this app's table and the
  factory call, nothing else.
- Dirty-gating: `createDirtyGate` (`@olivierzal/homey-kit/webview`) is
  the ONE primitive behind the
  Update/Refresh pair — never re-derive its invariant at a call site. The gate also freezes the gated
  fieldsets while a request is in flight (container `disabled` +
  `aria-busy`, so a control's own domain `disabled` survives the thaw):
  every success path rewrites the fields, so a mid-flight edit would be
  silently clobbered — pass every region the arming source reads through
  `fieldsetElements`. Arming comes from exactly ONE source, exclusive by
  type: baseline mode (`serialize`, a pure snapshot — never a
  request-body builder) or predicate mode (`isActionable`, no baseline
  at all; `markSaved` then only re-evaluates) — this app's single pair
  is baseline-mode. Disabled greying styles `button:disabled`
  generically, never a per-class list. The kit's own suite locks the
  behavior — a change to the gate is a kit release, adopted here by an
  exact-pin bump.
- Home ATA devices (`home-melcloud`) do NOT expose
  `measure_temperature.outdoor`; only Classic ATA devices do. The
  default outdoor-source selection and the sensor list must never
  assume it.
- Both ATA drivers share `thermostat_mode` values (incl. `cool`) and
  the 10–31 °C `target_temperature` range; the setpoint ceiling is read
  from `capabilitiesObj` at runtime (31 °C fallback).
- The comfort setpoint and the debt are ONE record, not two. It is the
  `previous` member of the `adjustments` entry (below): what the device
  held when the app engaged is both the floor the calculation uses and
  the value owed back, so a separate `thresholds` map was a second store
  for the same number, kept in step by hand — exactly the kind of pair
  that drifts when one side's sanitizer drops an entry. The key is gone;
  installs carrying it just stop reading it. A missing entry means
  ABSENT, never a stand-in value: nothing is written and
  `log.noThreshold` is reported (it used to send 0 °C — the placeholder
  reaching the unit as a real command). A missing outdoor reading is
  treated the same way: no efficiency floor rather than one computed
  from 0, and `#getTargetTemperature` returns `null` when neither floor
  is known. A setpoint the app cannot READ is refused the same way: the
  device is left unadjusted rather than written into a debt that could
  never be repaid (`Number()` used to turn that absence into 0, or into
  a NaN that JSON stored as `null` and the sanitizer then dropped).
- Restoring a setpoint is EVENT-INDEPENDENT, and that is the whole
  design. The `adjustments` setting is a ledger of what this app owes
  each device — `{ previous, written }`, what it found and what it put
  there — written on every successful write and cleared only once the
  device has taken its value back. It has exactly two writers, named for
  their intent: `recordComfort` (the value found, then any the user
  chooses) and `recordWrite` (what actually reached the device); each
  keeps the other member. The capability listeners remain the
  fast path (leaving cooling settles immediately), but correctness lives
  in `#reconcileAdjustments`, which runs on every restart (boot, device
  add/remove, settings apply) and re-judges every outstanding debt
  against the LIVE `thermostat_mode`. That is what survives the four
  ways a listener never sees a device leave cooling: a realtime
  reconnect (homey-api wires no `onReconnect`, so missed events are
  never replayed), a crash or reboot with no `unload`, the extension
  being disabled, and a device opted out of adjustment — a device
  `DISABLED_SOURCE` excludes from `autoAdjustCooling` must still get
  back what was taken from it. Two refusals are deliberate: a setpoint
  that no longer holds `written` carries a decision made after ours and
  stands (`log.kept`), and an unreadable one settles nothing, leaving
  the debt for a later pass rather than commanding blind. Never make
  the restore depend on the threshold map, on a live listener, or on
  having witnessed the transition.
- Restarts are SERIALIZED (`#queueRestart`): `autoAdjustCooling` is a
  critical section — tear down, settle, rebuild — and two overlapping
  runs (a device event landing on a settings apply) raced for the same
  device slots, leaving a listener installed by the losing run alive but
  unreachable, still writing setpoints nothing could settle. The
  listener registry is keyed by device id for the same reason: an array
  cleared by length reset cannot express ownership.
- Independent per-device work goes through `settleAll`
  (`lib/settle-all.mts`), not `Promise.all`: the aggregate must attempt
  every branch and report each failure on its own. `Promise.all` would
  abandon the restart at the first rejection — skipping the very
  reconciliation meant to repair it — and would surface one reason while
  hiding the others. Keep `Promise.all` only where the caller genuinely
  cannot continue without every branch.
- Outdoor sources are per device (`outdoorSources` setting: null/absent
  = Homey weather, `'none'` = the device is not adjusted at all); the
  legacy global `capabilityPath` is migrated to every known AC device
  once, then unset.
- Both per-device maps are reached ONLY through the app's accessor pairs
  (`outdoorSources`, `thresholds`): the key name and its sanitizer live
  together, the getter hands back a sanitized fresh copy, and no caller
  can write past the contract its reader assumes.
- Entries for devices Homey no longer knows are deliberately NOT pruned.
  They are inert — `#inheritedSource` matches on the live grouping, and
  Homey ids are UUIDs, so a stale entry can neither be resurrected nor
  influence an inheritance. Pruning was designed and refused: the only
  place to run it is after `#loadDevices`, which empties the device list
  before its network call, so any hiccup (com.melcloud stopped, a failed
  read) would wipe every source and threshold the user configured — and
  a wrongly-pruned source does not self-heal, the device re-seeds as a
  newcomer straight to `DISABLED_SOURCE`. Map hygiene does not justify a
  destructive operation on user configuration.
- Grouping joins on the MELCLOUD id (`device.data.id`), never the Homey
  id: `/devices/groups` speaks MELCloud ids while every settings map is
  keyed by Homey id. `lib/group-devices.mts` exports `toJoinKey` as the
  single home for that conversion — confusing the two spaces silently
  broke building inheritance for every newcomer, and test fixtures must
  give devices a `melcloudId` distinct from their `id` or they cannot
  catch it.
- The Homey weather (home-screen temperature) is served by the LOCAL
  weather manager. Route it through the connected homey-api session's
  generic `call({method, path: '/api/manager/weather/weather'})`: the
  app-side `homey.api.get` rejects with `Missing Session`, and homey-api
  ships no weather manager wrapper (absent from its local
  specification). Read `temperatureCelsius`, not `temperature`
  (unit-dependent); poll it (no push events), readings are sanitized by
  `lib/to-temperature.mts` (anything non-finite reads as null, never
  0/NaN).

## Naming & authored-content conventions

- What `@typescript-eslint/naming-convention` cannot see is convention
  too: booleans read as questions even untyped (`isX`/`hasX`), handlers
  as verbs; a name states what the thing IS, never its history. Test
  files are named after the unit under test (`<module>.test.ts`); shared
  test helpers keep their family's names — apps say `assertDefined` and
  `mock(overrides)` where the libraries say `defined` and
  `mock(value?)`: two test families, deliberately not unified.
- Static markup and styles live in `.html`/`.css` files. TS builds DOM
  only when the content is programmatic (computed values, per-item
  nodes), via `createElement` — never `innerHTML` (`no-unsafe-dom-html`
  enforces it). Inline style writes are reserved for values CSS cannot
  express; anything static belongs in the stylesheet, following the
  CSS/HTML lint rules' spirit even where no rule captures it.
- The webview runtime floor (es2023: no `Object.groupBy`/`Map.groupBy`,
  no iterator helpers, no `v` regex flag) is DERIVED, not precautionary:
  the Homey mobile app requires iOS 16.4 or later (App Store, read
  2026-08-11) and a Homey app only ever gets the system WebKit, so the
  worst legitimate engine is iOS 16.4's — es2023-complete, short of
  every es2024 gain (`Object.groupBy` and `Promise.withResolvers` need
  Safari 17.4, the `v` flag 17). es2024 becomes derivable when that App
  Store minimum reaches 17.4; Android never binds the floor, its System
  WebView being evergreen.
- The floor is enforced by a scoped lint block over `settings/` — the
  tsconfig cannot express two runtimes in one project. A
  `tsconfig.webview.json` floor was probed and refused on com.melcloud
  (2026-08-06): tsc checks the import CLOSURE, which crosses into
  node-side code — the same shape exists here (`settings/` imports
  shared `lib/` and `types/` modules).
- TWO floors coexist, on UNRELATED engines — never let one move the
  other. On the **webview** side the danger is APIs, because esbuild
  lowers syntax but NEVER polyfills (`Object.groupBy`, iterator
  helpers…); the `v` flag joins them because esbuild defers it instead
  of lowering it — under the bundler's es2020 target the literal ships
  as a `new RegExp` call, so an escapee fails at RUNTIME, inside the
  feature that runs it, not at parse. Narrower blast radius, same ban.
  The **node-side** floor is the Homey's own Node, and it is held by
  the manifest's `compatibility` declaration, not by a check.
- A floor is declared from WHERE THE CODE RUNS, never from what a
  dependency happens to require. `compatibility: ">=12.9.0"` is
  Athom's own documented Node 22 boundary ("as of Homey v12.9.0, all
  Homey platforms run apps on Node.js v22") and already covers the
  `engines` of every shipped dependency. Raising it cannot express
  more than it already does: the two firmware lines are numbered
  independently, so one semver range cannot say "has Node 22" across
  both — and on Homey Pro (2016-2019) the Node 22 firmware is still
  only a release candidate, so a raise would cut off that whole stable
  install base rather than a few laggards.
- Node-side runtime APIs above es2022 are therefore LEGITIMATE:
  `toSorted`/`toReversed` (Node 20), `Object.groupBy` (Node 21) and
  `Promise.withResolvers` (Node 22) all predate the declared engine,
  and `@olivierzal/homey-kit` already calls `toSorted` inside the boot
  path. Never rewrite one away for an engine the manifest does not
  claim — `pushToUI`'s `toReversed` and `group-devices.mts`'s
  `toSorted` stay exactly as they are. The same holds for syntax:
  `files.mts` reads its JSON through import attributes, the statically
  analysable form, and node-side regexes take the family's `v` flag —
  only the webview globs step down to `u`, and that step-down is the
  scoped block's job, never a second overlay.

## Tooling boundary (@olivierzal/configs)

The shared tooling lives in `@olivierzal/configs` (exact pin): the
eslint `homeyApp` preset (plugins are the package's dependencies — no
plugin devDeps here; the webview floor rides its `webviewFloorFiles`
glob), the prettier config (`"prettier"` key in package.json, no local
file) and the `tsconfig/app` base (`outDir` stays local — paths in an
extended tsconfig resolve against the base file inside node_modules).
The overlay keeps ONLY per-repo verdicts: the lint ignores and the
`**/*.d.ts` block around `homey-api-override.d.ts`. Naming comes whole
from the family core, strict by default — properties are camelCase and
the only departures are the preset's scoped escapes (capability-shaped
keys for the platform, quoted keys, the `__` sentinel). Re-tightening it
locally is not worth what it costs: the rule's options array replaces
rather than merges, so a partial override silently drops every entry it
omits, and a full copy drifts from the core it duplicates. Do not
re-declare family policy locally — a rule evaluation or version bump
happens in configs, adoption is a reviewed pin bump. The
ci/claude/dependabot/dependency-review/pr-title/zizmor workflows are
stubs calling the family reusables in OlivierZal/configs, pinned
`@<sha> # vX.Y.Z`; dependency vulnerabilities are GitHub's own —
Dependabot alerts scan continuously and carry the named, reasoned
dismissals (an exception lives on the advisory, so it cannot outlive
it, and this repo's `parseuri` ReDoS is dismissed there), while
`dependency-review` judges what a PR introduces;
`publish.yml` and `validate.yml` stay local (no reusable exists).
`.npmrc` (scope registry + `NODE_AUTH_TOKEN` auth) is load-bearing:
the configs devDependency lives on GitHub Packages, where even reads
need auth.

## Runtime boundary (@olivierzal/homey-kit)

`@olivierzal/homey-kit` (exact pin, a PRODUCTION dependency — the
manifest reader runs on the device) owns what used to be copied across
the three apps: the dirty gate and the freshness handshake
(`/webview`), the settings transport (`/settings`), the manifest reader
(`/node`), `fireAndForget`/`getErrorMessage`
(root) and the two test kernels (`/testing`). A change to any of them
is a kit release adopted here by a pin bump — never a local edit, and
never a re-derivation.

What stays local, by measurement rather than omission:

- The webview `fireAndForget` in `settings/index.mts`: it surfaces in
  the dev tools, it does not log through a logger instance. The kit's
  node-side seam takes `(promise, logger, message)` and is what every
  `app.mts`/`listeners/**` site uses.
- `lib/errors.mts` (`NotFoundError`): unlike the two sibling apps, this
  one forces `super('notFound')` and `api.mts` throws it with NO
  argument, because `settings/index.mts` matches on that exact message
  (`message === 'notFound'`) to tell "no MELCloud device paired yet"
  from a real failure. Swapping in the kit's class — whose message is
  whatever the caller passes — would silently break that branch, and no
  test would see it. Extend the kit class or keep this one; never
  replace it blind.
- The `ManagerSettings` augmentation: the local block is STRICTER than
  the kit's generic (no `(key: string) => unknown` overload) and carries
  `unset`, which the generic lacks. Adopting it would loosen this app.
- `homey-api-override.d.ts`, and the `lib/` helpers no sibling shares.

`api.mts` passes the manifest URL to `getWebviewHashes` explicitly: the
kit's default resolves `../webview-hashes.json` against its own module,
which sits in `node_modules` — only the caller knows where the bundler
stamped it. Dropping that argument silently disables the freshness
handshake (the reader fails open with an empty map).

## Lint doctrine

- Code adapts to the rules, never the reverse. Never add a disable —
  not inline, not through config options or ignore regexes: refactor
  until the rule passes. One counterweight: when every compliant shape
  reads worse than the violation (a rule-pair conflict, a
  protocol-imposed form), the documented disable IS the honest form.
  Current irreducibles: the fire-and-forget disable (once, in
  `lib/fire-and-forget.mts` — the settings page wraps it for its
  default `onError`) and the TS9019 isolatedDeclarations carve-out in
  `lib/homey.mts`.
- Naming is stricter than com.melcloud: properties are camelCase-only
  in app code. The tests block relaxes it (documented in the config)
  because test doubles mirror external contracts: capability ids
  (snake_case, dotted), device ids (hyphenated), module export names
  (PascalCase) and Homey's `__` translation method.
- Ambient `*.d.ts` files have a scoped carve-out (script parse,
  namespace-merged classes) — also documented in the config.
- A config-level `'off'` with a one-line reason is not a disable: it
  is the triage ledger for opt-in rules that were evaluated and
  refused (tool-ownership overlap, platform floor, absent domain).
  Disables suppress an adopted rule; ledger entries record a verdict —
  re-evaluate one when its stated reason expires (target bump, new
  tooling).
- Zero-warning policy: every enabled rule is at `error`.
- Test doubles are SYNC where the real API is async (the caller's
  `await` handles both): `mockImplementation(async …)` without an await
  trips `require-await`, and non-async promise-returning arrows trip
  `promise-function-async` — type the `vi.fn` as value-returning
  instead.
- `useDefineForClassFields` wipes fields assigned by `super()`: a
  subclass re-declaring an Error option (like `cause`) must use
  `declare`, not a field initializer.
- All-type exports hoist the keyword (`export type { A, B }`); mixed
  exports keep inline `type` specifiers, mirroring the
  inline-type-imports style. No shipped rule enforces the export side
  (`consistent-type-exports` tolerates inline specifiers once present;
  `import-x/consistent-type-specifier-style` covers imports only): the
  convention is maintained by hand, in review — a bespoke
  `no-restricted-syntax` selector for it was removed by decision
  (2026-07-28).

## Repo process

- Companion docs are part of a change's definition of done: whenever a
  PR changes behavior, API surface, requirements or process, the same
  PR updates the affected companion files (README.md, CONTRIBUTING.md,
  SECURITY.md, CLAUDE.md) — never a later sweep; the 2026-08 README
  audit caught exactly the drift this prevents (a shipped Home ATW
  driver absent from its README, a stale `Result` kind list).
- Every substantive wave ends with a cleanup pass over its own diff —
  residue (history comments, orphaned helpers, stale doc claims),
  simplification, and the factoring the change just made possible.
  Features land first, the sweep runs second, so the sweep covers
  them; a wave is not done until that pass has run.

- Design phases (on Olivier's call, start and end): iterate on
  `design/*` branches with dev-installs only — no PR merges, no tags,
  no releases, no App Store publishes until he lifts the pause.
- `main` is protected (PRs only, squash merges); CI must be green.
- The PR title IS the commit that lands: `squash_merge_commit_title` is
  `PR_TITLE`, so the title is the single source (under the former
  `COMMIT_OR_PR_TITLE`, a one-commit PR silently took its commit subject
  instead). It must follow Conventional Commits, which the required
  `PR title` check enforces (`.github/workflows/pr-title.yml`,
  byte-identical in the SEVEN repos that call the family reusables —
  every repo but `configs`, which hosts them and whose own copy
  differs; md5-verified 2026-08-30, the count having gone stale at five
  when `api-core` joined) — default type set, no scope
  allowlist, and no `subjectPattern`: subjects legitimately open on a
  proper noun. Dependabot's prefixes are pinned to `build(deps)` /
  `build(deps-dev)` rather than inferred, which is what had it land a
  different style in each repo.
  The **subject** casing stays inferred and cannot be pinned:
  `commit-message` accepts only `prefix`, `prefix-development` and
  `include`, so Dependabot keeps matching each repo's own history
  (`Bump undici` in one, `bump temporal-polyfill` in another). Left
  alone by decision (2026-08): a Dependabot commit subject is not a
  contract, the PR title is — and the `PR title` check already holds
  that one.
- After every push, monitor the triggered pipelines to completion — the
  PR checks after a push, the publish run after a release tag — and act
  on the outcome: rerun transient infra failures (a SonarCloud 504 is
  not a finding), fix real ones. Work is not done while its pipeline is
  red or unwatched.
- Copilot reviews every PR, and every review thread (Copilot or human)
  must end RESOLVED: with a code change when the point holds, or with a
  reasoned reply when it does not — verify claims against sources
  before acting either way. Resolve the thread once settled; none left
  dangling.
- SonarCloud must be spotless for a PR to merge — and the quality gate
  passing is necessary, NOT sufficient: the free-tier gate tolerates
  3 % duplication on new code, lets code smells through, and cannot be
  customized, so the real bar is ours, held in review. That bar is
  zero on BOTH windows — new code and overall alike: zero open issues
  of every kind (bugs, code smells, vulnerabilities) across the whole
  project, 0 % duplicated lines across the whole codebase, and 100 %
  coverage (within the exclusions `sonar-project.properties`
  declares). A Sonar finding is handled like a lint error — the code
  adapts, or the divergence is settled as a documented verdict — never
  merged over.
- Homey App Store releases: write the user-facing changelog entry into
  `.homeychangelog.json` under the NEW version key (all 13 locales —
  the com.melcloud set), bump `version` in `.homeycompose/app.json`,
  align `package.json` via `npm version X.Y.Z --no-git-tag-version`,
  run `homey:validate` to regenerate `app.json`, and land it all
  through a PR. Then tag `vX.Y.Z` and publish a GitHub release:
  `publish.yml` fires on release-published (environment `homey`,
  `HOMEY_PAT`) and pushes to the App Store. Fallback when the secret is
  stale (`The access token provided is invalid`): `homey app publish`
  from an authenticated CLI — answer NO to the version prompt (a yes
  bumps and rewrites app.json) and let the changelog come from
  `.homeychangelog.json`.
- Store submissions: a rejected version number cannot be resubmitted —
  bump the patch version.
- Sonar: the CI upload step self-arms on the `SONAR_TOKEN` secret (a
  job-level env gate — the secrets context is not valid in step `if`).
  Adding the secret requires disabling automatic analysis on
  sonarcloud.io first (the two modes conflict).
