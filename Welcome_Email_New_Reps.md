# Welcome email — four new reps plus Mitch

**Send from the same address DealRipe sends briefings from** (`MAIL_FROM` in
`.env.local`, e.g. `notify@dealripe.com`). Not from your personal address. The
whole point is that marking this one as safe also whitelists every briefing and
recap that follows, and Outlook's Safe Senders works per address, not per domain.

**Send it before the call, not during.** Waiting on delivery with six people
watching is a bad look, and Juan's briefings were delayed once already.

**To:** arodriguez@magaya.com, dblitstein@magaya.com, sjohnson@magaya.com,
asuntrup@magaya.com, mnemmers@magaya.com
**Cc:** Mark Buman

Juan and Eduardo are deliberately not on this. They already marked DealRipe as a
safe sender, and re-sending would only muddy the "did it arrive?" check.

---

**Subject:** Before our call: find this email in your junk folder

Hi all,

We're setting up DealRipe on your calendars at noon today. It takes about two
minutes per person.

One thing to do before we start, because it is the single most common problem
we've had:

**Please find this email and mark it as not junk.** It may be in your Junk
folder rather than your inbox. If it isn't in either, check your Barracuda
quarantine digest and release it from there.

This matters because everything DealRipe sends you comes from this address. If
it stays filtered, you'll get nothing and assume the tool isn't working. That
happened to Juan, to Eduardo, and to Mark, who spent a week thinking his weekly
digest had never been sent.

What you'll start receiving:

- A briefing before each customer call, with what was said last time, what's
  still unconfirmed, and the questions worth asking.
- A recap after each call, with the notes already written up so you can paste
  them into Rolldog instead of typing them.

Nothing sends to your customers. Follow-up emails are drafted into your Outlook
Drafts folder for you to review and send yourself.

See you at noon.

Maanit

---

## For Mitch

Mitch is not connecting a calendar, so he won't be doing the step that reminds
everyone else. He does get the weekly digest at 6am Monday, so he needs the
safe-sender fix as much as the reps do. Worth saying his name on the call so it
does not get skipped.

## On the call, in this order

1. Confirm each person found the email and marked it not junk. Do this first,
   while everyone is together. Anyone who cannot find it in inbox, junk, or the
   Barracuda quarantine is the case where Ernesto is required, and you want to
   know that now rather than Thursday.
2. Calendar connect, one link each.
3. Run `npx tsx scripts/preflight-reps.ts` live. Six green rows is the proof
   that setup worked, and it takes ten seconds.
4. Ask Mitch for the Rolldog user ids for Ariel, Daniel and Steven. Without
   them, reconciliation cannot attribute their calls, and it fails silently.
5. Confirm the surname spellings for Ariel Rodriguez, Daniel Blitstein and
   Steven Johnson. Those are inferred from email addresses, and they will appear
   in digests Mark reads.
