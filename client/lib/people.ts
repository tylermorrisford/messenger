interface Person {
  name: string | null;
  email: string;
}

export function displayName(person: Person): string {
  return person.name?.trim() || person.email;
}

/** Avatar initials: first and last word of the name, or the email's local part */
export function nameParts(person: Person): { firstName: string; lastName: string | undefined } {
  const words = displayName(person).split('@')[0].split(/\s+/).filter(Boolean);

  return { firstName: words[0] ?? '', lastName: words.length > 1 ? words[words.length - 1] : undefined };
}
