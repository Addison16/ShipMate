# Crew templates

Each folder is a starter crew member: `crew.yaml` (the manifest) plus `CREW.md` (persona and
instructions). On first boot Shipmate copies `captain/` into `/data/crew/captain`, and seeds `shipwright/`
(the Shipyard's default coder) whenever it is missing. The Captain
recruits the rest from these templates or from scratch.

`.previous/<slug>/` keeps earlier stock versions of a template's `CREW.md`. On boot, a crew
member whose `CREW.md` still matches one of them exactly (nobody has edited it) is upgraded to
the current template; edited files are never touched. When you change a template's `CREW.md`,
copy the old one into `.previous/<slug>/<version>.md` first.
