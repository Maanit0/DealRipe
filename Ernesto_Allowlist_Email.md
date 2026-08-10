# Email to Ernesto — spam allowlist before Monday noon

Fill in the two bracketed values from your Resend dashboard before sending.
`MAIL_FROM` in `.env.local` has the exact sending address.

**To:** Ernesto (Magaya IT)
**Cc:** Mark Buman
**Subject:** Quick allowlist request before Monday's DealRipe rollout

---

Hi Ernesto,

We're adding four more reps to DealRipe on Monday, and I want to get ahead of one
issue before they start.

The Barracuda filter has been routing our emails to junk. It happened to Juan,
to Eduardo, and to Mark, who assumed for a week that the digest had never been
sent. Each of them fixed it on their own end by marking us as not junk, but with
four new reps starting at once I'd rather not have five people spend their first
day looking for emails that are sitting in a folder they never check.

Could you add an org-level allowlist for our sending domain?

- Sending domain: **dealripe.com**
- From address: **[paste MAIL_FROM, e.g. notify@dealripe.com]**
- Sending service: Resend
- SPF and DKIM: **[paste the records from Resend, or say "already configured and
  verified" if you'd rather he checked himself]**

The reps who'd be affected are Juan Lopez, Eduardo Bencomo, Alexandra Suntrup,
Ariel Rodriguez, Daniel Blitstein and Steven Johnson.

What they receive is a pre-call briefing before customer meetings and a recap
afterwards, so a delayed or missing email costs them the prep for a call that's
already started.

If an org-level rule isn't something you can do quickly, even confirming the
domain isn't on a block list would help, and I'll have each rep mark us as safe
on the call Monday.

Thanks for turning the Salesforce access around so fast last week. The JWT
connection is working and we're reading the Sales Development fields exactly as
you set them up.

Maanit

---

## Notes on the ask

**Why cc Mark.** He experienced this himself and said "it's our spam filter" on
the Aug 3 call. His name on the thread turns a vendor request into an internal
one, and he already knows the context so it costs him nothing.

**Why it's framed around the reps rather than around us.** Ernesto's incentive
is not making DealRipe work; it's not creating support tickets. Five people
hunting for missing email on Monday is his problem too.

**The fallback is real, not a softener.** If he can't act tonight, having every
rep mark the first email as not junk during the onboarding call does mostly
solve it, as it did for Juan and Eduardo. Say so, so he doesn't feel cornered
into a rushed change to a mail filter on a Sunday night.

**What to do if he doesn't reply.** Add one line to the onboarding agenda:
"check your junk folder for an email from DealRipe and mark it not junk." Have
each rep do it on the call while you're all together, not afterwards.
