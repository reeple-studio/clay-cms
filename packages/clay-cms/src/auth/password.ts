import bcrypt from "bcryptjs";

const SALT_ROUNDS = 10;

// ? A precomputed bcrypt hash (cost 10) of a throwaway string. Used to equalize
// ? login latency: on the user-not-found branch we still run a bcrypt verify
// ? against this constant so both the found and not-found paths pay the same
// ? ~bcrypt-cost time, closing the email-enumeration timing side channel.
// ? It never matches any real password (compare always returns false).
const DUMMY_HASH =
	"$2b$10$0sgjCkB7u8hsWnmA.lNsFecsWFZDL2QFcGUKp5bL1rzwu7.F0dOcq";

export async function hashPassword(plain: string): Promise<string> {
	return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(
	plain: string,
	hash: string,
): Promise<boolean> {
	return bcrypt.compare(plain, hash);
}

// ? Burn one bcrypt verify against the constant hash, ignoring the result.
// ? Call this on the not-found login branch so its timing matches the found
// ? branch. Always returns false.
export async function fakeVerifyPassword(plain: string): Promise<boolean> {
	return bcrypt.compare(plain, DUMMY_HASH);
}
