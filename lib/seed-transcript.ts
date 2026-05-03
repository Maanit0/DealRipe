export const lumoraDiscoveryTranscript = `
TopSort - Lumora Marketplace
Discovery Call #2
Date: April 14, 2026
Duration: 38 minutes
Participants: Jess Tanaka (TopSort, Senior AE), Marcus Chen (Lumora, VP Monetization)

---

Jess: Marcus, hey, thanks for making time again. I know you said you only had 30 minutes today so let me jump right in. I pulled together the technical deep-dive deck like you asked. Want me to share my screen?

Marcus: Yeah, let's do it. I've got a lot of internal pressure on this so the more concrete we can get the better.

Jess: Awesome. So as I mentioned last time, what we deploy is a full retail media stack. You've got the auction layer, the ML personalization, the advertiser-facing self-serve dashboard, all of it API-first so your engineering team isn't locked in. I'll walk through the architecture in a sec but first, just so I'm tailoring this right, where's your head at since we last talked?

Marcus: Honestly? Pretty good. I took the conversation back to the team and people are excited. We're losing somewhere around four million dollars a year by not monetizing seller traffic. Our sellers are basically begging for sponsored placement, we just don't have the infrastructure to give it to them. So you're solving a real problem.

Jess: That four million number, where's that coming from?

Marcus: We modeled it based on our top hundred sellers. They've all said they'd pay for promoted listings if we offered them. Average willingness to pay was around forty grand a year per seller. Conservative math gets us to four. Aggressive math is closer to seven or eight.

Jess: That's a beautiful number. And you said your sellers are home and lifestyle brands mostly?

Marcus: Yeah. About twelve thousand active sellers, the top tier is maybe eight hundred who do real volume. That's where the ad budget would come from initially.

Jess: Got it. Okay so let me show you what the rollout looks like. Phase one we'd typically do sponsored listings only. That gets you live in about three weeks if your engineering team is responsive. Phase two we'd layer in display banners, that's another four to six weeks. Phase three is the full self-serve advertiser portal which is where your sellers can actually manage their own campaigns. That's usually a Q3 timeline if you start in Q2.

Marcus: That matches what I was thinking. We want this live before holiday season. The window we keep talking about internally is being able to monetize peak Q4 traffic. If we miss that we're basically waiting until next year to see real revenue.

Jess: Totally hear you on holiday. Let me show you the auction layer. So when a shopper does a search on Lumora, our ML pulls in your first-party data, scores every potential ad against organic relevance, runs the auction in under fifty milliseconds, and serves the winning ad with full attribution. You can see here the dashboard your sellers would see, real-time ROAS, click-through, conversion lift compared to organic.

Marcus: This is good. This is what I've been pitching internally. Can you talk about how it integrates with our existing search infrastructure? We're on Algolia right now.

Jess: Yeah great question. We've integrated with Algolia at three other clients. It's a standard pattern for us, your search team would basically expose two new endpoints and we handle the auction logic on our side. Most of the lift is on us. I can send you the technical docs after this.

Marcus: Send those over. Actually, can you also send the Poshmark case study? Adi Thacker referenced it in a podcast and that's basically the model we want to follow.

Jess: Already in your inbox by end of day. So tell me, who else on your side needs to see this?

Marcus: Right so the conversation right now is mostly me. My CTO Priya has been more cautious. Her team estimated a fourteen month internal build which I think is wildly optimistic but she keeps coming back to "why are we paying for something we could build." So I need to get her bought in.

Jess: We hear that a lot. Honestly the build versus buy conversation usually ends the same way. By the time you've built it you're maintaining it forever and your team isn't shipping core marketplace features. We can run a side-by-side TCO analysis if that helps you with Priya.

Marcus: That'd be useful. Yeah let's do that.

Jess: Done. I'll get that to you next week. Anyone else? Like, who's actually going to sign the contract on your end?

Marcus: I mean it'll go through our normal procurement process. We've got a finance team obviously. But I think if Priya and I are aligned we can move pretty fast.

Jess: Got it. So timing-wise, if we wanted to hit a Q4 holiday go-live, we'd want to have a signed contract in hand by mid-June at the latest. That gives us six to eight weeks for phase one implementation, then your team has time to onboard sellers before peak.

Marcus: Mid-June feels doable. We'd need to move on this in the next four to six weeks I'd say.

Jess: Perfect. Let me also flag, we have two competitive intel things you should know about. We hear sometimes that Criteo is in deals like this. They're a fine product but they're built for an older era, less API-first, harder to customize. If they show up in your evaluation just know we have specific battle cards I can share.

Marcus: Yeah Criteo reached out actually. We took a meeting two weeks ago. Honestly didn't love it.

Jess: What didn't you love?

Marcus: They wanted to template us into one of their existing deployments. Felt very off-the-shelf. Your approach of letting us customize the auction logic for our specific category mix is more what we want.

Jess: That's exactly the feedback we get. Cool, so what are next steps from your side?

Marcus: I want to get Priya in a room with you. Probably bring our principal engineer too. Can we do a technical deep dive next week?

Jess: Absolutely. I'll get our solutions architect on that one. Send me three time windows and I'll lock it in. And Marcus, between now and then is there anything specific I can put together for you that would help you internally?

Marcus: The TCO analysis. The Algolia integration docs. The Poshmark case study. If you've got a one-pager I can show Sarah that walks through what the holiday Q4 revenue impact looks like, that would be huge.

Jess: Sarah is your CEO right?

Marcus: Yeah. I haven't formally looped her in yet but I want to be ready when I do.

Jess: Got it. I'll have all of that to you by Wednesday. Anything else?

Marcus: I think that's it. Thanks Jess, this was helpful.

Jess: Always. Talk soon.
`;

const TRANSCRIPTS: Record<string, string> = {
  "lumora-discovery-2": lumoraDiscoveryTranscript,
};

export function getTranscriptById(id: string | null | undefined): string | null {
  if (!id) return null;
  return TRANSCRIPTS[id] ?? null;
}