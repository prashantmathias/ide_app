function calculateFibonacci(n: number): number[] {
  console.log(`Calculating Fibonacci up to ${n} terms...`);
  const sequence = [0, 1];
  
  for (let i = 2; i < n; i++) {
    const nextNumber = sequence[i - 1] + sequence[i - 2];
    sequence.push(nextNumber);
    console.log(`Step ${i}: Added ${nextNumber}`);
  }
  
  return sequence;
}

const terms = 6;
const result = calculateFibonacci(terms);
console.log(`Calculation complete: ${result.join(", ")}`);
