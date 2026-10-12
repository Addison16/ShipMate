# Crew templates

Each folder is a starter crew member: `crew.yaml` (the manifest) plus `CREW.md` (persona and
instructions). On first boot Shipmate copies `captain/` into `/data/crew/captain`, and seeds `shipwright/`
(the Shipyard's default coder) and `bosun/` (the reviewer a project can turn on for its
issue-to-PR jobs) whenever they are missing. The Captain
recruits the rest from these templates or from scratch.

Folders with a `starter.yaml` are **starter crew packs**, offered during first-run setup and
under **Crew → Add starter crew**: Galley (meals and groceries), Purser (bills), Navigator
(calendar, travel, weather), Tutor and Health Log. `starter.yaml` holds a one-line `blurb` and
an optional `watch` (`name`, `cron`, `prompt`) that is created paused for the person who adds the
crew member. It is not copied into the crew folder. Installed starter crew get the instance's
default model instead of the one in their `crew.yaml`, and may only list MCP servers from
`packages/mcp-catalog/catalog.json`.

`.previous/<slug>/` keeps earlier stock versions of a template's `CREW.md`. On boot, a crew
member whose `CREW.md` still matches one of them exactly (nobody has edited it) is upgraded to
the current template; edited files are never touched. When you change a template's `CREW.md`,
copy the old one into `.previous/<slug>/<version>.md` first.
