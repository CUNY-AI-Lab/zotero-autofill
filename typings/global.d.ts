declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

// Zotero 10 multi-selection getters, absent before Zotero 10.
declare namespace _ZoteroTypes {
  interface ZoteroPane {
    getSelectedLibraryIDs?(): number[];
    getSelectedCollections?(asIDs?: false): Zotero.Collection[];
  }
}
