# tests/site

Non-interactive QA harness for the static page `../../index.html`.

It drives a real headless Chrome (puppeteer-core over `file://`) and checks:
console cleanliness, layout and overflow at many viewports, content fidelity
against `../../README.md` and `./prank.sh list`, interactions (filters, search,
expand/collapse, deep links, copy buttons, matrix highlight, tab order, skip
link), accessibility (axe-core plus computed-style contrast), reduced motion,
print, JS-disabled, zoom, offline fonts, HTML validity and a design-constraint scan.

## Run

```
cd tests/site
npm install            # once: puppeteer-core, axe-core, html-validate (dev tooling only)
node qa.js             # exit 0 = no FAIL, 1 = at least one FAIL, 2 = harness error
```

Environment variables:

| variable      | meaning                                                              |
|---------------|----------------------------------------------------------------------|
| `CHROME_PATH` | Chrome/Edge executable (auto-detected on Windows/Linux/macOS)        |
| `QA_OUT`      | output folder for screenshots, `print.pdf`, `results.json`           |
| `QA_ONLY`     | comma list of groups: `load,layout,content,interact,a11y,motion,robust,html,design` |

Requirements: Node 18+, Chrome or Edge, `bash` on PATH (to run `./prank.sh list`;
falls back to parsing the script source), optional Python 3 with `pypdf` for the
text check of the print PDF.

Statuses: PASS, FAIL (fails the run), WARN (reported, does not fail), INFO.
`node_modules/` is git-ignored.

Network: the page loads Google Fonts, so the run needs internet access for the
"with fonts" baseline; the offline-fonts check blocks those hosts on purpose.
