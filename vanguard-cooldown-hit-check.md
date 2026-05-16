# Lightblinded Vanguard Cooldown Hit Check

Source: Warcraft Logs report `q2MY3xV6thgw8frC`, Mythic Lightblinded Vanguard pulls 1-20.

Scoring used completed `cast` events only, with a hit window of `+/-8s` from the copied WowUtils assignment time. Text/personals notes were not scored.

Nuduliniel's planned `325197` entries were scored against WCL spell ID `322118` (`Invoke Yu'lon, the Jade Serpent`), because the log records the casts as Yu'lon rather than Chi-Ji.

Detailed timeline audit: `vanguard-assignment-timeline.html`

## Summary

- Overall assigned CD hit rate: about `82%`
- Best serious pull: pull 19 at `92%`
- Worst pull: pull 1 at `59%`
- Best progressed pulls:
  - Pull 13: `87%`
  - Pull 14: `84%`
  - Pull 16: `84%`
  - Pull 19: `92%`
  - Pull 20: `91%`

## Main Issues

- `Nuduliniel 325197` is a spell ID mismatch in the export. WCL logs these as `322118` (`Invoke Yu'lon, the Jade Serpent`). After remapping, the early Yu'lon assignments were good: `20/20` at `0:12` and `14/16` at `2:24`. The late `5:03` Yu'lon remained weak: `1/4` on time.
- Angeyja's `472433` drifted on later repeats, especially the `3:58` assignment, which was often 20-33s early or missed.
- Ardek's `370537` was often off-timing at `1:53` and `3:24`.
- The `5:00-5:07` block degraded on several progressed pulls.

## Death Context

Across all pulls, there were `92` non-hit assignments after the Yu'lon remap. Of those, `30` had the assigned player already dead at the assignment time, and `4` more had another assignee for the same mechanic/time block dead. Those should be treated differently from clean misses.

On the progressed pulls:

| Pull | Assignment | Result | Death Context |
| --- | --- | --- | --- |
| 13 | `5:21` Angeyja `421453` | Miss | Angeyja died at `5:05` |
| 13 | `5:41` Angeyja `472433` | Off-timing | Angeyja died at `5:05`; only earlier cast existed |
| 14 | `5:00` Globalisten `97462` | Miss | Globalisten died at `4:29` |
| 14 | `5:05` Skäggbuff `391528` | Miss | Skäggbuff died at `3:33` |
| 14 | `5:07` Ardek `370537` | Miss | Ardek died at `5:05` |
| 16 | `5:00` Globalisten `97462` | Miss | Globalisten died at `4:49` |
| 19 | `5:03` Nuduliniel Yu'lon `322118` | Early | Angeyja, another nearby assignee, died at `5:15`; likely not the reason for the early cast |
| 19 | `5:21` Angeyja `421453` | Miss | Angeyja died at `5:15` |
| 20 | `3:58` Angeyja `472433` | Miss | Angeyja died at `3:17` |

## Player Reliability

| Player | Reached | Hits | Hit Rate | Misses | Off-Timing |
| --- | ---: | ---: | ---: | ---: | ---: |
| Valenzor | 16 | 15 | 94% | 1 | 0 |
| Lillpill | 52 | 47 | 90% | 3 | 2 |
| Skäggbuff | 99 | 89 | 90% | 10 | 0 |
| Zaijko | 16 | 14 | 88% | 2 | 0 |
| Ardek | 134 | 108 | 81% | 5 | 21 |
| Nuduliniel | 95 | 77 | 81% | 6 | 12 |
| Globalisten | 23 | 18 | 78% | 5 | 0 |
| Sinxytwo | 16 | 12 | 75% | 3 | 1 |
| Angeyja | 67 | 46 | 69% | 6 | 15 |

## Best Progress Pulls

| Pull | Duration | Boss Left | Reached Assignments | Hit Rate | Main Misses |
| --- | ---: | ---: | ---: | ---: | --- |
| 13 | 5:44 | 30.43% | 39 | 87% | Angeyja late/miss, Skäggbuff Tranquility, Ardek early |
| 14 | 5:19 | 24.34% | 37 | 84% | Late Angeyja, `5:00-5:07` block, Yu'lon early |
| 16 | 5:16 | 24.85% | 37 | 84% | Late Conduit, Angeyja early, `5:00+` block |
| 19 | 5:39 | 22.36% | 38 | 92% | Angeyja `3:58` early, Yu'lon early at `5:03`, `5:21` miss |
| 20 | 4:11 | 36.35% | 32 | 91% | Lillpill late, Conduit early, `3:58` Angeyja miss |

## Recurring Problem Assignments

| Time | Assignment | Reached | Result |
| --- | --- | ---: | --- |
| 5:03 | Nuduliniel `325197` -> Yu'lon `322118` | 4 | 1 hit, 1 miss, 2 early |
| 3:58 | Angeyja `472433` | 8 | 1 hit, often 20-33s early |
| 5:21 | Angeyja `421453` | 2 | 0 hits / 2 misses |
| 1:53 | Ardek `370537` | 18 | 8 hits, 9 off-timing |
| 3:24 | Ardek `370537` | 10 | 6 hits, 4 off-timing |
