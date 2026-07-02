# Floistad demo + pre-call briefing (Jun 17, 6am)

## Start
```
npm run dev
```
Open: **http://localhost:3000/forecast?tenant=cobalt**
(or click the **Cobalt** toggle in the top-right switcher)

The account is intentionally generic B2B SaaS ("Cobalt"), not built to look like his
company. It lives in `lib/demos/cobalt/index.ts`. Nothing else changed; TopSort and the
live Lumora deal page are untouched.

---

## OPENING — SPIN (let him do most of the talking; naive-student framing)

**Situation**
1. "Just so I'm anchored: you've got Gong, Salesforce, Outlook, and you run MEDDPICC
   across about 150 open opps. Who actually lives in Gong day to day, you, your
   managers, or the reps?"
2. "When you build the weekly forecast, are you taking the reps' commit at face value,
   or discounting it from your gut?"
3. "What share of your reps consistently reach the economic buyer before late stage,
   versus working the champion?"

**Problem**
4. "When Gong isn't on a call, a phone call, an in-person, a Teams call it didn't join,
   how confident are you in what's in Salesforce for that deal?"
5. "When a deal slips out of commit, how long is it usually between it going sideways
   and you finding out?"
6. "How often do you open a deal and the stage gate was filled with just enough to
   advance, not because it was real?"

**Implication**
7. "When the forecast is off because of that, what does it cost you downstream? You
   mentioned it flows to budget and EBIT."
8. "If a committed deal slips a full quarter because the CFO was never engaged, what
   does that one miss do to your number for the half?"
9. "Across 150 opps, if even a handful are green in Salesforce but actually
   economic-buyer-late, how much of your committed number is sitting on that?"

**Need-payoff**
10. "If you could see, before your forecast call, exactly which committed deals are
    economic-buyer-late and the one move to fix each, what would that change about how
    you run Wednesday?"
11. "If your reps got the one missing question before each call so the Salesforce data
    was actually trustworthy, what's that worth to your forecast accuracy?"

→ Then: "That's exactly what I want to show you. None of these are things Gong solves."

---

## DEMO (Cobalt account)
1. **Forecast Room** — target $2.5M / DealRipe $1.34M / rep commit $1.78M (overcommit
   $440K). "Commit the rep number, you miss by $440K."
2. **What changed this week** —
   - *Brightwave* down 21: "CFO declined Tuesday, economic buyer 19 days untouched,
     rep working the champion not the signer." (his #1 pain, on screen)
   - *Parkside Group* down 11: "Green in Salesforce, but the last 3 touches were phone +
     in-person, no Gong. A competitor surfaced in an email Gong never saw." →
     *"Gong only knows the calls it joined."*
   - *Keystone* up 6: clean commit.
3. **Start Pipeline Review** → walk the leverage cards (economic-buyer + paper-process
   plays). Close: *"Every one of these is a move your current tooling reads as on track."*
4. For the live extract/evidence act, drop into **Lumora** (existing wired deal).

## "How is this different from Gong?" (he will ask)
"Three things. Gong only knows the calls it joined, I cover the phone, in-person, and
Teams calls it misses plus email and calendar. Gong gives you a score, I give you the
verbatim quote behind every gate. Gong is a dashboard you consult, I run your forecast
meeting and learn when the deal lands. And I sit on top of Gong, you rip nothing out."

---

## END ASKS (leave with the next meeting)
- **Pilot:** "Run it on 2–3 of your real deals for 30 days, no cost. Success = the
  write-back matches what a great rep would log, and we flag economic-buyer or
  paper-process risk before you'd otherwise see it. Worth a shot?"
- **Access:** "If yes, who owns Salesforce and Gong access on your side, so I can scope it?"
- **Book it on the call:** "Let's put 30 minutes on the calendar two weeks out to look at
  what it surfaced. Wednesday or Friday better?"
- **Fallback if lukewarm:** "Even if a pilot isn't right yet, can I get 20 minutes with
  one of your frontline managers to see how they'd use it?"

## Not changed (flagged)
- Deep Opportunity Control / Extract / Prepare is still wired to **Lumora (Scotsman)**
  only. A MEDDPICC deep deal is a bigger, riskier build, best done awake.
- The standalone **Pipeline** tab is hardcoded to TopSort. Use **Start Pipeline Review**
  from the Forecast Room while on Cobalt, not the Pipeline tab.
