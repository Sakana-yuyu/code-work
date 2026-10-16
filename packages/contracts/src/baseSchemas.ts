import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Wire codec for server→client arrays whose element unions grow over time
 * (new literal members, new struct variants). Decoding drops elements the
 * current build cannot decode instead of failing the whole payload — a client
 * has to keep decoding configs sent by servers newer than itself, and
 * rejecting the payload would take down the connection over data the client
 * couldn't act on anyway. Encoding is the plain array encoding.
 */
export const ForwardCompatibleArray = <Element extends Schema.Top>(element: Element) => {
  const decodeElement = Schema.decodeUnknownOption(element as never);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(element),
      SchemaTransformation.transform<ReadonlyArray<Element["Encoded"]>, ReadonlyArray<unknown>>({
        decode: (values) =>
          values.filter((value) => Option.isSome(decodeElement(value))) as ReadonlyArray<
            Element["Encoded"]
          >,
        encode: (values) => values,
      }),
    ),
  );
};

/**
 * Optional field whose value union may grow over time (new literal members).
 * A value this build cannot decode becomes `undefined` instead of failing the
 * enclosing struct — same reasoning as `ForwardCompatibleArray`: settings and
 * project files written by a newer build must stay readable by older ones.
 */
export const ForwardCompatibleOptional = <Value extends Schema.Top>(value: Value) => {
  const decodeValue = Schema.decodeUnknownOption(value as never);
  return Schema.optionalKey(
    Schema.Unknown.pipe(
      Schema.decodeTo(
        Schema.UndefinedOr(value),
        SchemaTransformation.transform<Value["Encoded"] | undefined, unknown>({
          decode: (raw) =>
            Option.isSome(decodeValue(raw)) ? (raw as Value["Encoded"]) : undefined,
          encode: (raw) => raw,
        }),
      ),
    ),
  );
};

/**
 * The nullable form, for a persisted setting whose literal set grows over
 * time: a member this build does not know (or a missing key) decodes as null
 * rather than failing the enclosing struct. Encoding is the plain encoding.
 */
export const ForwardCompatibleNullable = <Value extends Schema.Top>(value: Value) => {
  const decodeValue = Schema.decodeUnknownOption(value as never);
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.NullOr(value),
      SchemaTransformation.transform<Value["Encoded"] | null, unknown>({
        decode: (raw) => (Option.isSome(decodeValue(raw)) ? (raw as Value["Encoded"]) : null),
        encode: (raw) => raw,
      }),
    ),
  );
};

const knownTags = (
  members: ReadonlyArray<Schema.Top & { readonly fields: object }>,
  tag: string,
): ReadonlySet<string> => {
  const tags = new Set<string>();
  for (const member of members) {
    const field = (member.fields as Record<string, unknown>)[tag] as
      | { readonly literal?: unknown; readonly literals?: ReadonlyArray<unknown> }
      | undefined;
    for (const literal of field?.literals ?? [field?.literal]) {
      if (typeof literal !== "string") {
        throw new Error(`Every ForwardCompatibleUnion member needs a string literal ${tag}.`);
      }
      tags.add(literal);
    }
  }
  return tags;
};

/**
 * A member of a {@link ForwardCompatibleUnion} whose tag this build does not
 * know. A class, so only the codec can make one: no decoded payload, however
 * it is shaped, is ever mistaken for it.
 */
export class UnknownUnionMember<Tag extends string = string> {
  readonly tag: Tag;
  readonly value: string;
  constructor(tag: Tag, value: string) {
    this.tag = tag;
    this.value = value;
  }
}

/**
 * Wire codec for a server→client tagged union a newer server may add members
 * to. A value whose `tag` field holds a value this build does not know decodes
 * to {@link UnknownUnionMember} instead of failing; a known member decodes
 * through its own schema, so a broken known payload still fails. Callers
 * decide what an unknown member means: skip it, or show a fallback.
 *
 * Unknown members are decode-only; encoding one fails.
 */
export const ForwardCompatibleUnion = <
  const Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>,
  const Tag extends string,
>(
  members: Members,
  tag: Tag,
) => {
  const known = knownTags(members, tag);
  const unknownMember = Schema.Struct({
    [tag]: Schema.String.check(
      Schema.makeFilter(
        (value: string) => !known.has(value) || `A known ${tag} must decode in full.`,
      ),
    ),
  } as Record<Tag, Schema.String>).pipe(
    Schema.decodeTo(Schema.instanceOf(UnknownUnionMember<Tag>), {
      decode: SchemaGetter.transform(
        (raw: Record<string, string>) => new UnknownUnionMember(tag, raw[tag]!),
      ),
      encode: SchemaGetter.forbidden(() => `Unknown ${tag} values are never sent.`),
    }),
  );
  return Schema.Union([...members, unknownMember]) as unknown as ForwardCompatibleUnion<
    Members,
    Tag
  >;
};
export type ForwardCompatibleUnion<
  Members extends ReadonlyArray<Schema.Top>,
  Tag extends string,
> = Schema.Codec<
  Members[number]["Type"] | UnknownUnionMember<Tag>,
  Members[number]["Encoded"],
  Members[number]["DecodingServices"],
  Members[number]["EncodingServices"]
>;

/**
 * Whether a raw, undecoded value carries a `tag` this build does not know
 * among `members`. For checks outside a {@link ForwardCompatibleUnion}, such
 * as an envelope that must skip a payload of an unknown kind.
 */
export const hasUnknownUnionTag = (
  members: ReadonlyArray<Schema.Top & { readonly fields: object }>,
  tag: string,
): ((value: unknown) => boolean) => {
  const known = knownTags(members, tag);
  return (value) =>
    typeof value === "object" &&
    value !== null &&
    tag in value &&
    !known.has((value as Record<string, unknown>)[tag] as string);
};

/** Whether a decoded {@link ForwardCompatibleUnion} value is a member this build does not know. */
export const isUnknownUnionMember = <A>(
  value: A,
): value is Extract<A, UnknownUnionMember<string>> => value instanceof UnknownUnionMember;

/**
 * An array of a growing tagged union that drops members this build does not
 * know. Known members decode through their own schema and still fail when
 * broken. Encoding is the plain array encoding.
 */
export const ForwardCompatibleUnionArray = <
  const Members extends ReadonlyArray<Schema.Top & { readonly fields: object }>,
  const Tag extends string,
>(
  members: Members,
  tag: Tag,
) =>
  Schema.Array(ForwardCompatibleUnion(members, tag)).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(Schema.Union(members))),
      SchemaTransformation.transform<
        ReadonlyArray<Members[number]["Type"]>,
        ReadonlyArray<Members[number]["Type"] | UnknownUnionMember<Tag>>
      >({
        decode: (values) =>
          values.filter((value) => !isUnknownUnionMember(value)) as ReadonlyArray<
            Members[number]["Type"]
          >,
        encode: (values) => values,
      }),
    ),
  );
export type ForwardCompatibleUnionArray<
  Members extends ReadonlyArray<Schema.Top>,
  _Tag extends string,
> = Schema.Codec<
  ReadonlyArray<Members[number]["Type"]>,
  ReadonlyArray<Members[number]["Encoded"]>,
  Members[number]["DecodingServices"],
  Members[number]["EncodingServices"]
>;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Brand) => {
  return TrimmedNonEmptyString.pipe(Schema.brand(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;
export const RpcClientId = NonNegativeInt.pipe(Schema.brand("RpcClientId"));
export type RpcClientId = typeof RpcClientId.Type;

/**
 * Which client app a connection comes from. Unlike
 * `AuthClientMetadataDeviceType` (a UA-style device class where web and
 * desktop are both "desktop"), this names the actual product surface.
 * Optional everywhere it appears: old clients never send it.
 */
export const ClientSurface = Schema.Literals(["web", "desktop", "mobile"]);
export type ClientSurface = typeof ClientSurface.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;
