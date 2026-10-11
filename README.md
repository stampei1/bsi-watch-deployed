# BSI Watch — deployed-tool demo

A simulated allo-HCT unit showing how a stool-microbiome bloodstream-infection (BSI) risk score could sit inside a
clinical workflow: a list grouped by what needs a look today (new positive blood culture, needs review, reviewed,
low risk), a short review screen with the score, its change since the last sample, how fresh it is and what raised
it, and a workflow-only review choice. Step through days with ‹ › or the arrow keys.

Tiers match BSI Timeline: High = the cut-off that catches 50% of pre-infection stool samples, Watch = 90%, with each
tier's observed rate of BSI within 14 days. Reviews are a demo stored only in your browser.

**Data.** 18 real, de-identified, retrospective allo-HCT timelines from MSK (Xavier Lab), time-shifted onto one
simulated unit; bed numbers are made up. Scores are out-of-fold predictions of the 14-day E. coli and Enterococcus
models; cut-offs were chosen on the same cohort and have not been validated prospectively. Not for clinical use.
