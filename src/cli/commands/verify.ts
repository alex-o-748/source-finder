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

  console.log(`Verdict:         ${verdict.verdict}`);
  console.log(`Confidence:      ${verdict.confidence}/100`);
  console.log(`Reliability:     ${verdict.reliability}`);
  console.log(`  why:           ${verdict.reliabilityReason}`);
  console.log(`Comments:        ${verdict.comments}`);
}
