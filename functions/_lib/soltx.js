export const TX_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' };
export const txKey = sig => JSON.stringify(['getTransaction', [sig, TX_OPTS]]);
