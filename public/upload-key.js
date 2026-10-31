// Idempotency key holder. The key survives failed or lost-response attempts
// so a retry of the same file cannot create a second upload. It resets only
// after a 2xx response or when a different file is chosen.
export function createKeyHolder(gen = () => crypto.randomUUID().replace(/-/g, '')) {
  let key = null;
  let fileId = null;
  return {
    forFile(id) {
      if (key === null || id !== fileId) {
        key = gen();
        fileId = id;
      }
      return key;
    },
    succeeded() {
      key = null;
      fileId = null;
    },
  };
}

export const fileIdOf = (f) => `${f.name}|${f.size}|${f.lastModified}`;
