// Not cryptographically secure -- fine here since these are just local
// primary keys, not anything security-sensitive. Avoids pulling in
// react-native-get-random-values / expo-crypto (native modules that would
// need a fresh `expo prebuild` + rebuild) just to generate an id.
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
