export const resolveAsyncCollectionCreationMode = (input: {
  readonly createRequested: boolean;
  readonly isPending: boolean;
  readonly itemCount: number;
}): boolean => input.createRequested || (!input.isPending && input.itemCount === 0);
