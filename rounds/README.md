# Round records

The judgement record for A/B and critic rounds: what each judge was shown, what
it wrote, and what the scorer made of the lot. Images are NOT kept here — they
are megabytes each and the frames themselves live in `shots/`; `round.json`
names the source file for every task.

Built and scored by `tools/ab-round.js` and `tools/critique-round.js`. See
`DEFECTS.md` D28 for why these rounds have controls in them.

`d28-sham`, `d28-obvious` and `d28-mush` are the three validation rounds that
established what the A/B protocol can and cannot do. They are kept because an
instrument that has never been shown a known answer is not an instrument.
