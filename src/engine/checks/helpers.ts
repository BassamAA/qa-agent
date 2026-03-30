let counter = 0;

export function makeId(category: string, name: string): string {
  counter++;
  const slug = name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  return `${category}-${slug}-${counter}`;
}
