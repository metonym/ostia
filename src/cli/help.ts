export const TIME_HELP = `ostia time [flags] <command...>
ostia time [flags] -- <argv...>

Time commands as subprocesses. Each <command> is whitespace-split into argv (no shell);
everything after -- is one more command's argv, verbatim.

Flags:
  --samples N          exact trials per command (default: ~3s budget, at least 10)
  --budget MS          sampling time budget per command
  --min-samples N      floor on trials when --samples isn't given
  --warmup N           discarded warmup trials (default: 3)
  --no-interleave      run commands one after another instead of round-robin
  --prepare CMD        run before every trial, unmeasured; once, or once per command
  --time-source REGEX  take each trial's time from capture group 1 in the command's output
  --time-unit UNIT     unit of --time-source: ns | us | ms | s (default: ms); needs --time-source
  --cpu                capture one extra CPU-profile trial
  --heap               capture one extra heap-snapshot trial
  --cpu-interval US    CPU sampling interval (default: 1000); needs --cpu
  --timeout MS         kill a trial or --prepare hook after MS
  --ignore-failure[=CODE,...]  treat these exit codes (bare: all) as success
  --out-dir PATH       artifact directory (default: node_modules/.cache/ostia)
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the ProfileDocument to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

A command stops at its first non-ignored non-zero exit.
Exit codes: 0 ok, 2 a command failed or produced no samples (or a bad flag), 130 Ctrl-C.

Examples:
  ostia time "bun a.ts" "bun b.ts"
  ostia time --samples 25 --cpu --heap "bun src/server.ts"
  ostia time --prepare "rm -rf dist" "bun build.ts"
  ostia time --time-source "built in (\\d+)ms" "bun build.ts"
  ostia time -- bun -e "console.log('a b')"
`

export const BENCH_HELP = `ostia bench [flags] <suite.ts...>

Run in-process group()/task() suites, each file in its own child process. With no files,
uses ostia.config's "bench" section; each flag overrides its config field.

Flags:
  --budget MS          sampling budget per task (default: 500)
  --samples N          exact trials per task (ignores --budget)
  --min-samples N      floor on trials (default: cost-aware, 3-20)
  --jobs N|auto        suite files at once (default: 1; >1 adds noise)
  --isolate            one process per task, not per file (--no-isolate to undo config)
  --gc                 Bun.gc(true) between trials (--no-gc)
  --cpu                extra per-task CPU profile with JIT tiers, ~2,000 samples (--no-cpu)
  --cpu-interval US    CPU sampling interval (default: 100)
  --alloc              extra per-task retained-heap-per-call measurement: what calls keep
                       alive after a full GC, not what they allocate (--no-alloc)
  --peak-mem           extra per-task RSS rise during the task's first call, garbage
                       included; median of 3 fresh processes (--no-peak-mem)
  --filter REGEX       only tasks whose "group/name" matches
  --preload PATH       import before each suite file (repeatable, in order)
  --bun-flags FLAGS    extra flags for the bun process running each suite (repeatable)
  --timeout MS         kill a suite (or isolated task) process after MS
  --out-dir PATH       scratch directory (default: node_modules/.cache/ostia)
  --config PATH        read this config file instead of ostia.config.ts/.json
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the ProfileDocument to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

Per-task/per-group options ({ budgetMs, minSamples, gc, isolate, cpu, alloc, peakMem }) override
the suite-wide defaults. Exit codes: 0 ok, 2 a suite failed (or a bad flag), 130 Ctrl-C.

Examples:
  ostia bench bench/*.ts
  ostia bench bench/*.ts --filter parse --cpu --alloc
  ostia bench --preload ./bench/dom-setup.ts --bun-flags="--conditions=browser" bench/*.ts
`

export const AB_HELP = `ostia ab [flags] <suite.ts...>

Pair every task on a git ref's committed tree (base) against the working tree (candidate), in
one process, alternating ~10ms batches, and gate on the per-round time ratio. Drift between
the two sides cancels within a round. Each suite runs twice, once with each side first, and
the rounds are pooled. With no files, uses ostia.config's "bench" suites.

Flags:
  --base REF           git ref for the base side (default: HEAD)
  --base-setup CMD     shell command run once in a freshly extracted base tree, e.g. to build
                       gitignored files the suites import (repeatable, in order)
  --rounds N           base/candidate rounds per task (default: 15)
  --threshold PCT      flag a task whose median ratio moves past PCT (default: 10)
  --geomean-threshold PCT  fail when the geometric mean of all ratios is slower than PCT
                       (default: 1.5)
  --confirm N          re-measure each flagged task in N fresh processes (default: 2; 0 skips)
  --alloc              also compare retained heap per call on each side (--no-alloc)
  --peak-mem           also compare each side's first-call RSS rise (--no-peak-mem); both
                       run in 3 fresh processes per side, and the median counts
  --mem-threshold PCT  flag a memory reading that moves past PCT of the base's and past
                       its noise floor (default: 10)
  --filter REGEX       only tasks whose "group/name" matches
  --preload PATH       import before each suite file (repeatable, in order)
  --bun-flags FLAGS    extra flags for the bun process running each suite (repeatable)
  --timeout MS         kill a suite (or repeat) process after MS
  --out-dir PATH       scratch directory and base-tree cache (default: node_modules/.cache/ostia)
  --keep-trees N       base trees to keep cached, least recently used go first (default: 5)
  --clean              remove every cached base tree, then exit
  --config PATH        read this config file instead of ostia.config.ts/.json
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the ProfileDocument to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --progress           print progress to stderr (default: when stderr is a terminal and not
                       --quiet); --no-progress turns it off
  --quiet              don't print the report
  --help               show this message

The base tree is cached per commit (and --base-setup commands) under --out-dir. Setup runs
with the project's node_modules linked in, and OSTIA_AB_SHA and OSTIA_AB_CANDIDATE_DIR (the
working tree) set. A flagged task counts only when every fresh-process repeat flags it the
same way. A task that throws isn't timed; one that throws on the candidate side only fails
the run. A task whose suite file and output both changed reads "not comparable" and stays
out of the verdict. Exit codes: 0 pass, 1 a confirmed regression, a candidate-only throw,
the geomean over its threshold or a memory regression, 2 nothing paired or a harness error (not a git repo,
unknown ref, a failed setup or suite), 130 Ctrl-C.

Examples:
  ostia ab bench/parse.bench.ts
  ostia ab bench/*.ts --base origin/main --rounds 21
  ostia ab bench/*.ts --filter parse --format minimal
  ostia ab bench/*.ts --base-setup "bun scripts/generate.ts"
  ostia ab bench/paint.bench.ts --alloc --peak-mem
`

export const COMPARE_HELP = `ostia compare <base.json> <candidate.json>
ostia compare <candidate.json> --baseline <base.json>

Compare two ProfileDocuments by workload id. Gates on ostia.config's "thresholds" when
present (the same ones "ostia ci" uses), else the defaults.

Flags:
  --baseline PATH      the base document, when only the candidate is positional
  --config PATH        read thresholds from this config file instead of ostia.config.ts/.json
  --export-json PATH   write the candidate document with comparisons to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

Exactly two document paths (one with --baseline); anything more is an error.
Exit codes: 0 pass, 1 a workload regressed, 2 nothing matched or a harness error.
`

export const REPORT_HELP = `ostia report <document.json> [flags]

Render a saved ProfileDocument. Files, not a GUI for the visualization formats -
hand the output to speedscope.app, flamegraph.pl, or a Mermaid renderer.

Formats:
  table        terminal timing/CPU/heap/comparison text (default)
  json         pretty JSON document
  jsonl        one metadata line, then one line per measurement
  markdown     agent- and human-readable report
  minimal      one compact JSON object per timing measurement, for LLM/CI consumption
  collapsed    folded stacks: "root;a;b 42" - flamegraph.pl and most flame tooling
  mermaid      call tree, top-15 frames by total time (never the whole profile)
  speedscope   sampled profile JSON for speedscope.app
  cpuprofile   verbatim .cpuprofile pass-through (cpu-prof/inspector origins only)

Flags:
  --format FORMAT     one of the formats above (default: table)
  --measurement <id>  visualization formats only: render only this measurement
                       (default: every CPU measurement in the document)
  --out-dir PATH      visualization formats only: write files here instead of stdout
  --help              show this message

Examples:
  ostia report doc.json
  ostia report doc.json --format markdown
  ostia report doc.json --format speedscope --out-dir node_modules/.cache/ostia/viz
  ostia report doc.json --format collapsed | flamegraph.pl > flame.svg
`

export const CI_HELP = `ostia ci [flags]

Run ostia.config's workloads (reusing cached runs whose declared inputs are unchanged),
compare against a saved baseline, and gate on regressions.

Flags:
  --full               ignore the cache
  --baseline NAME      baseline to compare against (default: config "baseline", or "main")
  --save-baseline      after a pass, save this run as the new baseline (always measures
                       fresh: the cache is not used)
  --config PATH        read this config file instead of ostia.config.ts/.json
  --no-noise-check     skip the ~200ms noise-floor measurement
  --export-json PATH   write the candidate document with comparisons to PATH
  --format FORMAT      table | json | jsonl | markdown | minimal (default: table)
  --quiet              don't print the report
  --help               show this message

Exit codes: 0 pass, 1 regression, 2 harness error (missing config/baseline, a workload
failed or produced no samples, or an onMissingBaseline "fail" mismatch), 130 Ctrl-C (the
partial document is exported; nothing is compared or saved).
`

export const BASELINE_HELP = `ostia baseline <save|list|show> [args]

Manage the baseline ProfileDocuments "ostia ci" gates against and "ostia compare --baseline"
reads.

Flags (every subcommand): --config PATH reads that config file instead of
ostia.config.ts/.json.

Subcommands:
  save [name]              measure every configured workload (same code path as "ostia ci",
                            no comparison) and write it to <baselineDir>/<name>.json
                            (default name: config's "baseline" field, or "main")
  list                     list saved baselines: name, created date, workload count
                            (takes no arguments)
  show <name> [flags]      render a saved baseline, like "ostia report" (same
                            --format/--measurement/--out-dir flags)

Examples:
  ostia baseline save
  ostia baseline save my-feature
  ostia baseline list
  ostia baseline show main
  ostia baseline show main --format markdown
`

export const MAIN_HELP = `ostia - profiling and benchmarking for Bun

Commands:
  time      Time commands N times and report timing/CPU/heap
  bench     Run in-process benchmark suites (group()/task())
  ab        Pair suites against a git ref in one process, gate on regressions
  compare   Compare two ProfileDocuments
  report    Render a saved ProfileDocument (table/json/markdown/collapsed/mermaid/speedscope/...)
  ci        Run configured workloads against a baseline, gate on regressions
  baseline  Manage baseline ProfileDocuments (save/list/show)

Run "ostia <command> --help" for details.
`
