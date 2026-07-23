import { NeatDemoView } from "@/components/neat/NeatDemoView";

export const metadata = {
  title: "DealRipe · Second Nature",
};

export default function SecondNatureDemoPage() {
  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[900px] mx-auto px-6 py-8">
        <div className="mb-5">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">
            Representative example · not live data
          </div>
          <h1 className="text-[15px] text-ink font-semibold mt-1">
            How DealRipe reads a Zoom call and writes NEAT back to Salesforce
          </h1>
        </div>
        <NeatDemoView />
      </main>
    </div>
  );
}
