import * as z from 'zod/mini';
import type {
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import type {
	ApiKey,
	DashboardFile,
	FileContentLinkResponse,
	FileDetailResponse,
	FileListResponse,
	FileMutationResponse,
	FileSummary,
	FileTagsResponse,
	FileVersion,
	Passkey,
	Tag,
	TagResponse,
	UploadResponse
} from '@tdrive/shared';

const invalid = { error: 'The server returned unexpected data' };
const text = z.string(invalid);
const integer = z.int(invalid);
const flag = z.boolean(invalid);
const maybeString = z.nullable(text);

const fileSummary = z.object(
	{
		id: text,
		displayName: text,
		contentType: text,
		kind: z.enum(['file', 'site'], invalid),
		version: integer,
		sizeBytes: integer,
		public: flag,
		createdAt: text,
		expiresAt: maybeString,
		downloadCount: integer,
		lastDownloadAt: maybeString,
		indexState: z.enum(
			['pending', 'running', 'ready', 'failed', 'disabled'],
			invalid
		),
		indexedVersion: z.nullable(integer),
		indexAttempts: integer,
		indexError: maybeString
	},
	invalid
) satisfies z.ZodMiniType<FileSummary>;

const tag = z.object(
	{
		id: text,
		name: text,
		normalizedName: text,
		color: maybeString,
		fileCount: integer,
		createdAt: text
	},
	invalid
) satisfies z.ZodMiniType<Tag>;

const dashboardFile = z.extend(fileSummary, {
	deletedAt: maybeString,
	updatedAt: text,
	htmlForcedPublic: flag,
	tags: z.array(tag, invalid)
}) satisfies z.ZodMiniType<DashboardFile>;

const fileVersion = z.object(
	{
		version: integer,
		sizeBytes: integer,
		contentType: text,
		createdAt: text
	},
	invalid
) satisfies z.ZodMiniType<FileVersion>;

const semanticStatus = z.object(
	{
		enabled: flag,
		indexedChunks: integer,
		dimensions: integer,
		model: text,
		costNotice: text
	},
	invalid
);

const fileListResponse: z.ZodMiniType<FileListResponse> = z.object(
	{
		files: z.array(dashboardFile, invalid),
		nextCursor: maybeString,
		tags: z.array(tag, invalid),
		contentOrigin: text,
		maxUploadBytes: integer,
		semantic: semanticStatus
	},
	invalid
);

const fileDetailResponse: z.ZodMiniType<FileDetailResponse> = z.object(
	{
		file: dashboardFile,
		versions: z.array(fileVersion, invalid),
		nextVersionsCursor: maybeString,
		availableTags: z.array(tag, invalid),
		contentOrigin: text,
		maxUploadBytes: integer,
		semanticEnabled: flag
	},
	invalid
);

const fileContentLink: z.ZodMiniType<FileContentLinkResponse> = z.object(
	{
		url: text,
		expiresAt: maybeString,
		version: integer,
		public: flag
	},
	invalid
);

const fileMutationResponse: z.ZodMiniType<FileMutationResponse> = z.object(
	{
		file: dashboardFile,
		forcedPublic: flag
	},
	invalid
);

const fileTagsResponse: z.ZodMiniType<FileTagsResponse> = z.object(
	{ file: dashboardFile },
	invalid
);

const uploadResponse: z.ZodMiniType<UploadResponse> = z.object(
	{
		file: fileSummary,
		url: text,
		forcedPublic: flag
	},
	invalid
);

const tagResponse: z.ZodMiniType<TagResponse> = z.object({ tag }, invalid);

const apiKey = z.object(
	{
		id: text,
		name: text,
		prefix: text,
		scope: z.enum(['read-only', 'read-write'], invalid),
		createdAt: text,
		expiresAt: maybeString,
		lastUsedAt: maybeString,
		revokedAt: maybeString
	},
	invalid
) satisfies z.ZodMiniType<ApiKey>;

const passkey = z.object(
	{
		id: text,
		name: text,
		createdAt: text,
		lastUsedAt: maybeString,
		deviceType: z.enum(['singleDevice', 'multiDevice'], invalid),
		backedUp: flag,
		currentSession: flag
	},
	invalid
) satisfies z.ZodMiniType<Passkey>;

const ceremonyId = z.string(invalid).check(z.regex(/^[0-9a-f]{32}$/, invalid));

const loginOptions = z.object(
	{
		challenge: text,
		rpId: text,
		timeout: integer,
		userVerification: z.literal('required', invalid)
	},
	invalid
) satisfies z.ZodMiniType<PublicKeyCredentialRequestOptionsJSON>;

const enrollOptions = z.object(
	{
		challenge: text,
		timeout: integer,
		rp: z.object({ id: text, name: text }, invalid),
		user: z.object({ id: text, name: text, displayName: text }, invalid),
		attestation: z.literal('none', invalid),
		authenticatorSelection: z.object(
			{
				residentKey: z.literal('required', invalid),
				userVerification: z.literal('required', invalid)
			},
			invalid
		),
		pubKeyCredParams: z.array(
			z.object(
				{
					type: z.literal('public-key', invalid),
					alg: integer
				},
				invalid
			),
			invalid
		),
		excludeCredentials: z.array(
			z.object(
				{
					type: z.literal('public-key', invalid),
					id: text
				},
				invalid
			),
			invalid
		)
	},
	invalid
) satisfies z.ZodMiniType<PublicKeyCredentialCreationOptionsJSON>;

export const parseFileListResponse = fileListResponse.parse;
export const parseFileDetailResponse = fileDetailResponse.parse;
export const parseFileContentLink = fileContentLink.parse;
export const parseFileMutationResponse = fileMutationResponse.parse;
export const parseFileTagsResponse = fileTagsResponse.parse;
export const parseUploadResponse = uploadResponse.parse;
export const parseTagResponse = tagResponse.parse;

export const parseApiKeyListResponse = z.object(
	{ keys: z.array(apiKey, invalid) },
	invalid
).parse;

export const parseApiKeyCreateResponse = z.object(
	{ key: apiKey, token: text },
	invalid
).parse;

export const parseSessionsRevokedResponse = z.object(
	{ revoked: integer },
	invalid
).parse;

const passkeyList = z.object({ passkeys: z.array(passkey, invalid) }, invalid);

export const parsePasskeyList = z.pipe(
	passkeyList,
	z.transform((response) => response.passkeys)
).parse;

export const parsePasskeyRemoval = z.object({ signedOut: flag }, invalid).parse;

export const parsePasskeyLoginOptions = z.object(
	{ ceremonyId, options: loginOptions },
	invalid
).parse;

export const parsePasskeyEnrollOptions = z.object(
	{ ceremonyId, options: enrollOptions },
	invalid
).parse;

export const parseErrorMessage = z.object({ message: text }).safeParse;
