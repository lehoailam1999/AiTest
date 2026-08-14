/**
 * Portable Unit primary preference: marker path/code match + prefer implementation
 * over I* interface when both exist. No product-specific paths.
 */
/** File stem without extension (UploadService / IUploadService). */
export declare function stemOfPath(pathRel: string): string;
/**
 * True for interface-like Unit primaries (C# IFoo, *.interface.*, /interfaces/).
 * Marker path: pointing here is still allowed as explicit override.
 */
export declare function isInterfaceLikePrimaryPath(pathRel: string): boolean;
/** Strip leading I from C# interface stem → implementation family stem. */
export declare function stripInterfaceStemPrefix(stem: string): string;
/**
 * Path matches TC path:/file: marker without latching IFoo onto Foo.
 * Accepts exact, endsWith("/marker"), or basename equality — not IFoo.cs ⊃ Foo.cs.
 */
export declare function pathsMatchMarker(candidatePath: string, markerPath: string): boolean;
/**
 * code: Foo matches Foo.cs / FooService.cs stem exact — not IFoo.cs.
 * Implementation stem may equal code or start with code as Pascal prefix.
 */
export declare function codeMatchesPathStem(code: string, pathRel: string): boolean;
/** Feature family stem for pairing IFooService ↔ FooService. */
export declare function implementationFamilyStem(pathRel: string): string;
/**
 * Among path candidates, prefer concrete implementation over I* interface
 * when both share the same feature family (UploadService vs IUploadService).
 * Among concretes, prefer *Handler/*Service over bare *Command/*Delete.
 */
export declare function preferImplementationOverInterface(paths: string[]): string[];
/**
 * If current primary is interface-like and pool has a concrete sibling, return sibling.
 * Otherwise return primary unchanged.
 */
export declare function promoteImplementationPrimary(primaryPath: string, pool: string[]): string;
/** True when primary matches at least one path: or code: marker (exact helpers). */
export declare function primaryMatchesMarkers(primaryPath: string, markers: {
    paths?: string[] | null;
    codes?: string[] | null;
}): boolean;
