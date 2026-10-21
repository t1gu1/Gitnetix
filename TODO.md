# TODO

## What's next

- Create a custom terminal emulator using a Nerd Font.
- Rework the worktrees & agent section and how it works.
- Add Undo
- Add a place to set and edit shortcuts
- Add a conflict manager and resolver (If AI, simply fix the conflit automatically with AI)
- Add more analytics (Possibility to target one of few person)
- Add Launchpad(Dashboard) a Cross-repo dashboard to manage PRs and get some analytics
- Add user on branches
- Add filter to commits to only show our branches

## Code signing

Release builds are only signed for the in-app updater (Tauri key). The installers themselves
are not code-signed, so macOS asks users to clear the quarantine flag (see README › Install)
and Windows SmartScreen shows "unknown publisher".

### Windows

Options, cheapest first:

| Option | Cost | Notes |
|---|---|---|
| [SignPath Foundation](https://signpath.org) | Free for OSS | Needs an approved OSS license, a public repo and CI builds (GitHub Actions supported). Project goes through a review. The certificate is issued to "SignPath Foundation", not to us. Most common choice for OSS apps. |
| Azure Trusted Signing | ~$10/month | Cheapest paid option, documented by Tauri. Individuals only eligible in some countries (started with US/Canada), check before relying on it. |
| Certum Open Source certificate | ~€30–70/year | Issued in our own name, made for OSS developers. Uses their cloud signing service (SimplySign). SmartScreen reputation builds slowly. |

A signed installer doesn't make the SmartScreen warning go away right away: Windows only trusts
it after enough people have downloaded it.

Implementation note: the installer must be Authenticode-signed **before** Tauri creates the
updater `.sig`. Signing it afterwards changes the file, so the `.sig` no longer matches and
in-app updates break. Use `bundle.windows.signCommand` in `tauri.conf.json` so signing runs at
the right point in the build.

### macOS

No free option. Apple only waives the fee for nonprofits, schools and government bodies,
not for individual OSS developers.

- Join the Apple Developer Program ($99/year) to get a Developer ID certificate and notarization.
- Add the CI secrets Tauri reads: `APPLE_CERTIFICATE` (base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, and either `APPLE_ID` + `APPLE_PASSWORD` (app-specific) + `APPLE_TEAM_ID`
  or an App Store Connect API key (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`).
- Remove the ad-hoc `bundle.macOS.signingIdentity: "-"` from `tauri.conf.json`.
- Remove the "macOS: first launch" workaround from the README.

### Plan

1. Windows: apply to SignPath Foundation now. Free, and approval takes a while.
2. macOS: keep the README workaround until the app has real users, then pay the $99 and turn on notarization.
