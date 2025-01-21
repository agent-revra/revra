import { z } from 'zod';

import { parseSchema } from './parse-schema.js';
import type { JsonSchema, JsonSchemaObject, Refs } from '../types.js';

export const parseMultipleType = (
	jsonSchema: JsonSchemaObject & { type: string[] },
	refs: Refs,
) => {
	return z.union(
		jsonSchema.type.map((type) => parseSchema({ ...jsonSchema, type } as JsonSchema, refs)) as [
			z.ZodTypeAny,
			z.ZodTypeAny,
		],
	);
};
