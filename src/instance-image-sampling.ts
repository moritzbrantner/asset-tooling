// Shared exact endpoint sampling used by height projection and saved-mask filtering.
export function roundDivideBigInt(numerator:bigint, denominator:bigint) {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error("instance projection ratio requires non-negative numerator and positive denominator");
  }
  return (numerator + denominator / 2n) / denominator;
}

export function sampleAxis(position:number, minimum:number, spanMicro:number, sampleCount:number) {
  if (sampleCount <= 1 || spanMicro <= 1) return 0;
  const numerator = BigInt(position - minimum) * BigInt(sampleCount - 1);
  return Number(roundDivideBigInt(numerator, BigInt(spanMicro - 1)));
}

