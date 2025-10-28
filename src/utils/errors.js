const formatError = (value) => {
  if (value instanceof Error) {
    return value.stack || value.message || value.toString();
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export { formatError };
