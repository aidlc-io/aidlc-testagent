# Expected coverage — saucedemo (checkout feature)

A good plan for the scoped `checkout` feature should produce at least these
scenarios, each tracing to the requirement or a manual case:

| Expected scenario            | Traces to                         | Stage |
| ---------------------------- | --------------------------------- | ----- |
| Log in (setup)               | requirement: login precondition   | setup |
| Happy-path checkout          | manual_test: TC-1                 | core  |
| Missing postal code rejected | manual_test: TC-2 / requirement   | edge  |
| Cart badge reflects count    | manual_test: TC-3                 | smoke |
| Total = item total + tax     | requirement: review totals        | core  |

Scoring (future `ata eval`): for each expected row, check that the generated
`plan.json` contains a scenario whose `tracesTo` includes the listed source.
Report covered / missing as a coverage percentage.
