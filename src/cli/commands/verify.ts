import { verifySource } from "../../core/verifySource.js";

interface VerifyArgs {
  claim: string;
  source: string;
  json: boolean;
}

export async function verifyCommand(args: VerifyArgs): Promise<void> {
  const verdict = await verifySource(args.claim, args.source);

  if (args.json) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    return;
  }

  console.log(`Supports: ${verdict.supports ? "yes" : "no"}`);
  console.log(`Confidence: ${verdict.confidence.toFixed(2)}`);
  if (verdict.supportingQuote) {
    console.log(`Quote: ${verdict.supportingQuote}`);
  }
  console.log(`Reasoning: ${verdict.reasoning}`);
}
