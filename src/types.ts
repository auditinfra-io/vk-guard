/** A single method's circuit measurements, as reported by `analyzeMethods()`. */
export type MethodEntry = {
  /** Number of constraint-system rows. Drives proving time. */
  rows: number;
  /**
   * Digest of the method circuit, from o1js `analyzeMethods()`.
   *
   * This is recorded in addition to `rows` because a row count is a weak
   * fingerprint: a refactor can swap one constraint for another and keep the
   * count identical. The digest changes whenever the circuit changes, and it is
   * available WITHOUT a full `compile()`, which is what makes `--rows-only` a
   * real check rather than a rubber stamp.
   */
  digest?: string;
};

export type ContractEntry = {
  /** Source file the contract was discovered in, relative to the project root. */
  file: string;
  /** Whether this is a SmartContract subclass or a ZkProgram. */
  kind: 'SmartContract' | 'ZkProgram';
  /**
   * The verification key hash, as a decimal field element string.
   *
   * We deliberately do NOT store `verificationKey.data`. That field is a
   * multi-kilobyte base64 blob; committing it would make `.vk-guard.json`
   * unreadable and produce enormous, unreviewable diffs. The hash is a binding
   * commitment to the key, so it is sufficient to detect any change, which is
   * the only question this tool asks. Absent in `--rows-only` snapshots.
   */
  verificationKeyHash?: string;
  /** Contract-level digest from `digest()`; cheap and covers all methods. */
  digest?: string;
  methods: Record<string, MethodEntry>;
};

export type SnapshotConfig = {
  /**
   * Allowed row drift. Keys are `"default"` or `"Contract.method"`.
   * A change within tolerance passes but is still printed. Tolerances never
   * apply to verification key hashes, which are always compared exactly.
   */
  rowTolerance?: Record<string, number>;
};

export type Snapshot = {
  vkGuardVersion: string;
  o1jsVersion: string;
  /** Optional policy, preserved across `vk-guard update`. */
  config?: SnapshotConfig;
  /** True if this snapshot was produced with `--rows-only` (no VK hashes). */
  rowsOnly?: boolean;
  contracts: Record<string, ContractEntry>;
};

/** A contract as found and measured in the working tree. */
export type Measured = ContractEntry & { name: string };
