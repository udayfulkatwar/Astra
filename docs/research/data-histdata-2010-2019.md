# Data: HistData M1, EUR/USD · GBP/USD · USD/JPY, 2010-01 → 2019-06

Genuine historical prices used for the first real-history research run. Nothing here was
generated, filled or repaired.

- **Source:** HistData.com "Generic ASCII" M1 files, as published in the public GitHub
  repository [`philipperemy/fx-1-minute-data`](https://github.com/philipperemy/fx-1-minute-data).
  The files are taken from the tree of commit `8bcf4a752e4777edd3b3e4c29221eb974d7affc6`
  (2019-09-02; reachable as `refs/pull/5/head`), directory `2000-Jun2019/`. The repository's
  current default branch no longer carries the data; this environment reached the older commit
  through GitHub's git transport, because it cannot reach data websites.
- **Files:** 45 zip archives, one per pair and year for 2010–2018 and one per pair and month
  for 2019-01 → 2019-06. Their SHA-256 checksums are in `data-histdata-2010-2019.sha256`. The
  unzipped CSVs are 3,485,336 (EUR/USD), 3,473,829 (GBP/USD) and 3,396,304 (USD/JPY) M1 rows.
  HistData's own status reports list gaps inside minutes; 13 gaps of 30 minutes or more are
  listed, weekends included.
- **Format:**
  - `YYYYMMDD HHMMSS;open;high;low;close;volume`;
  - **bid** prices;
  - times in **EST without daylight saving** (UTC−5 all year), converted to UTC by the research
    parser (ADR-0025).
- **Spot checks:** EUR/USD 2015-01-01 18:00 UTC is 1.2096, and USD/JPY 2019-06-21 is about
  107.3. Both agree with the published history of those dates.
- **Limits:**
  - There is no ask side, so the spread is **ASSUMED** at 0.8 pip on every pair. The
    sensitivity runs use 1.2 and 1.6 pip.
  - Before 2020, so it is not the SPEC's 2020–2026 window. That window remains the untouched
    confirmation period (`PROTOCOL-2026-09-29.md`).
  - Volume is zero in these files and is not used.

The data itself is not committed (`research-data/` is ignored by Git).
