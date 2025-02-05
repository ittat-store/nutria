// Higher level class to use the ContentManager api.

const PLACES_MIME_TYPE = "application/x-places+json";
const MEDIA_MIME_TYPE = "application/x-media+json";

export class ContentManager {
  constructor() {
    this.service = apiDaemon.getContentManager();

    this.placesQuery = new Map();
    this.placesUpdating = new Set();

    this.topLevel = new Map();
  }

  getPluginsManager(callback) {
    return new PluginsManager(callback);
  }

  log(msg) {
    console.log(`ContentManager: ${msg}`);
  }

  error(msg) {
    console.error(`ContentManager: ${msg}`);
  }

  async lib() {
    if (!this._lib) {
      await this.service;
      this._lib = apiDaemon.getLibraryFor("ContentManager");
    }

    return this._lib;
  }

  async getService() {
    let svc = await this.service;
    return svc;
  }

  async ensureHttpKey(svc) {
    try {
      if (!this.http_key) {
        this.http_key = await svc.httpKey();
      }
    } catch (e) {
      console.error(`Failed to retrive http key: ${e}`);
    }
  }

  // Formats tthe given size with the appropriate unit.
  formatSize(size) {
    // Exabytes should be enough.
    let prefixes = ["EB", "PB", "TB", "GB", "MB", "KB", "B"];
    let currentPrefix = prefixes.pop();
    let max = 1024;
    let factor = 1;
    while (size > max * factor) {
      currentPrefix = prefixes.pop();
      factor *= 1024;
    }

    return `${(size / factor).toFixed(2)}${currentPrefix}`;
  }

  iconFor(isFolder, mimeType) {
    let kind = "folder";

    if (!isFolder) {
      kind = "file";

      // Check the mime type to choose the most appropriate icon.
      if (mimeType) {
        if (mimeType === PLACES_MIME_TYPE) {
          kind = "link";
        } else if (mimeType === MEDIA_MIME_TYPE) {
          kind = "video";
        } else if (mimeType.startsWith("text/")) {
          kind = "file-text";
        } else if (mimeType.startsWith("image/")) {
          kind = "image";
        } else if (mimeType.startsWith("audio/")) {
          kind = "music";
        } else if (mimeType.startsWith("video/")) {
          kind = "video";
        }
      }
    }

    return kind;
  }

  // Returns the appropriate icon kind for a given resource.
  // The mime type used is the one from the default variant.
  async iconForResource(meta) {
    const lib = await this.lib();
    let mimeType = meta.variants.find(
      (variant) => variant.name == "default"
    )?.mimeType;
    return this.iconFor(meta.kind === lib.ResourceKind.CONTAINER, mimeType);
  }

  // Returns wether a named top level container already exists.
  async hasTopLevelContainer(containerName) {
    this.log(`hasTopLevelContainer ${containerName}`);
    if (this.topLevel.has(containerName)) {
      return true;
    }

    let svc = await this.service;

    let root = await svc.getRoot();
    try {
      await svc.childByName(root.id, containerName);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Returns the id of an existing or newly created container
  // which is a direct child of the root.
  async ensureTopLevelContainer(containerName) {
    if (this.topLevel.has(containerName)) {
      return this.topLevel.get(containerName);
    }

    let svc = await this.service;
    const lib = await this.lib();

    let root = await svc.getRoot();
    this.log(`Fetching children of ${root.id}`);

    let cursor = await svc.childrenOf(root.id);

    let id = null;
    let done = false;
    while (!done) {
      try {
        let children = await cursor.next();
        for (let child of children) {
          if (
            child.name === containerName &&
            child.kind === lib.ResourceKind.CONTAINER
          ) {
            id = child.id;
            done = true;
            this.log(`Found container with id ${id}`);
            break;
          }
        }
      } catch (e) {
        // cursor.next() rejects when no more items are available, so it's not
        // a fatal error.
        this.error(`Cursor error: ${JSON.stringify(e)}`);
        done = true;
      }
    }
    cursor.release();

    if (id === null) {
      this.error(`No '${containerName}' container found, creating one.`);
      try {
        let container = await svc.createobj(
          {
            parent: root.id,
            name: containerName,
            kind: lib.ResourceKind.CONTAINER,
            tags: [],
          },
          ""
        );
        id = container.id;
        this.log(`New container ${containerName} has id ${id}`);
      } catch (e) {
        this.error(
          `createObj error for ${containerName}: ${e} ${JSON.stringify(e)}`
        );
      }
    }

    if (id !== null) {
      this.topLevel.set(containerName, id);
    } else if (this.topLevel.has(containerName)) {
      // Check if we lost a race with another in-flight call.
      return this.topLevel.get(containerName);
    }

    return id;
  }

  // Returns the child by name in a given container.
  async childByName(parent, name, variant = "default") {
    let svc = await this.service;
    try {
      let meta = await svc.childByName(parent, name);
      let blob = await svc.getVariant(meta.id, variant);
      await this.ensureHttpKey(svc);
      return new ContentResource(svc, this.http_key, meta, blob, variant);
    } catch (e) {
      this.error(`childByName failed: ${JSON.stringify(e)}`);
      return null;
    }
  }

  // Simple way to create a leaf resource with an existing blob.
  async create(parent, name, blob, tags = []) {
    let svc = await this.service;
    const lib = await this.lib();

    let meta = await svc.createobj(
      {
        parent,
        name,
        kind: lib.ResourceKind.LEAF,
        tags,
      },
      ""
    );
    await this.ensureHttpKey(svc);
    let resource = new ContentResource(svc, this.http_key, meta, blob);
    await resource.update(blob);
    return resource;
  }

  async resourceFromId(id) {
    let svc = await this.service;
    await this.ensureHttpKey(svc);
    let meta = await svc.getMetadata(id);
    return new ContentResource(svc, this.http_key, meta);
  }

  isValidUrl(url) {
    // Don't add moz-extension urls to places since they don't survive extension re-installation.
    // Don't add about:reader urls since they are not meant to be navigated too directly.
    // Don't add about:blank since ... it's blank.
    if (
      url &&
      (url === "about:blank" ||
        url.startsWith("moz-extension:") ||
        url.startsWith("about:reader?url="))
    ) {
      return false;
    }
    return !!url;
  }

  // Remove the hash part if any.
  cleanupUrl(url) {
    let res = url.trim();
    let hash = res.indexOf("#");
    if (hash !== -1) {
      res = res.substring(0, hash);
    }
    return res;
  }

  // Creates or updates a places entry.
  async createOrUpdatePlacesEntry(url, title, icon) {
    url = this.cleanupUrl(url);
    if (!this.isValidUrl(url)) {
      return;
    }
    this.log(`createOrUpdatePlacesEntry: ${url} ${title} ${icon}`);

    // We need all places queries for a given url to be coalesced,
    // and will not apply intermediary changes.
    this.placesQuery.set(url, { url, title, icon });

    await this.drainPlacesQueryFor(url);
  }

  async visitUrl(url, container, highPriority = false) {
    if (!url) {
      return;
    }
    url = this.cleanupUrl(url);
    if (url === "") {
      return;
    }
    if (!this.isValidUrl(url)) {
      return;
    }

    this.log(`visit ${container} ${url}`);
    let svc = await this.service;
    const lib = await this.lib();

    let parent = await this.ensureTopLevelContainer(container);
    await svc.visitByName(
      parent,
      url,
      highPriority ? lib.VisitPriority.HIGH : lib.VisitPriority.NORMAL
    );
  }

  async visitPlace(url, highPriority = false) {
    await this.visitUrl(url, "places", highPriority);
  }

  async visitMedia(url, highPriority = false) {
    await this.visitUrl(url, "media", highPriority);
  }

  async drainPlacesQueryFor(url) {
    if (this.placesUpdating.has(url)) {
      return;
    }
    this.placesUpdating.add(url);

    let places = await this.ensureTopLevelContainer("places");
    while (this.placesQuery.has(url)) {
      let place = this.placesQuery.get(url);
      this.placesQuery.delete(url);

      let entry = await this.childByName(places, url);
      let content = new Blob([JSON.stringify(place)], {
        type: PLACES_MIME_TYPE,
      });
      let shouldUpdateIcon = true;
      if (entry) {
        let text = await entry.variant().text();
        if (text) {
          let current = JSON.parse(text);
          shouldUpdateIcon = current.icon !== place.icon;
        }

        await entry.update(content);
      } else {
        entry = await this.create(places, url, content, ["places"]);
      }
      if (shouldUpdateIcon) {
        await entry.updateVariantFromUrl(place.icon, "icon");
      }
    }
    this.placesUpdating.delete(url);
  }

  async createOrUpdateMediaEntry(url, icon, meta) {
    this.log(`createOrUpdateMediaEntry: ${url}`);
    let medias = await this.ensureTopLevelContainer("media");
    if (!medias) {
      this.error(`No top level 'media' container!`);
      return;
    }
    let entry = await this.childByName(medias, url);
    let media = {
      url,
      icon,
      title: meta.title,
      album: meta.album,
      artist: meta.artis,
      artwork: meta.artwork,
      ogImage: meta.ogImage,
      backgroundColor: meta.backgroundColor,
    };
    let content = new Blob([JSON.stringify(media)], {
      type: MEDIA_MIME_TYPE,
    });
    if (entry) {
      await entry.update(content);
    } else {
      entry = await this.create(medias, url, content, ["media"]);
    }

    await entry.updateVariantFromUrl(icon, "icon");

    let poster = meta.artwork?.[0]?.src != "" ? meta.artwork?.[0]?.src : null;
    let posterUrl = poster || meta.ogImage;
    if (posterUrl) {
      await entry.updateVariantFromUrl(posterUrl, "poster");
    }
  }

  // Performs a cursor iteration, calling the callback for each result.
  // The callback is expected to return a boolean indicating
  // if more results are needed.
  // It will be called with 'null' once the end of results is reached.
  async processCursor(cursor, withContent, variantNames, callback) {
    let start = Date.now();

    let svc = await this.service;
    await this.ensureHttpKey(svc);
    let lib = await this.lib();
    let done = false;

    this.log(`IIII processCursor init ok: ${Date.now() - start}`);
    while (!done) {
      try {
        let children = await cursor.next();
        this.log(`IIII processCursor cursor.next: ${Date.now() - start}`);

        let queue = [];

        for (let child of children) {
          if (withContent) {
            // Don't show containers.
            if (child.kind === lib.ResourceKind.CONTAINER) {
              queue.push(Promise.resolve(null));
              continue;
            }
            // Make sure that the default variant mime type is declared as JSON.
            const defaultVariant = child.variants.find((variant) => {
              return (
                variant.name === "default" && variant.mimeType.includes("json")
              );
            });
            if (!defaultVariant) {
              this.error(
                `The default variant for ${child.name} is not in json format!`
              );
              queue.push(Promise.resolve(null));
              continue;
            }

            queue.push(svc.getVariantJson(child.id, "default"));
          } else {
            done = !callback(child);
          }
        }

        if (withContent) {
          let root_url = `http://127.0.0.1:${window.config.port}/cmgr/${this.http_key}`;

          let results = await Promise.all(queue);
          let i = 0;
          for (let content of results) {
            let child = children[i];
            i += 1;

            // Non json default variant resolve to null, bail out for these.
            if (!content) {
              continue;
            }

            // Get the requested variants urls if they are declared to be available for this resource.
            let availableVariants = new Set();
            child.variants.forEach((variant) => {
              availableVariants.add(variant.name);
            });
            let variants = { default: content };
            for (let i = 0; i < variantNames.length; i++) {
              let name = variantNames[i];
              if (availableVariants.has(name)) {
                variants[name] = `${root_url}/${child.id}/${name}`;
              }
            }
            done = !callback({ meta: child, variants });
            if (done) {
              break;
            }
          }
        }
      } catch (e) {
        // cursor.next() rejects when no more items are available, so it's not
        // a fatal error.
        // this.error(`Cursor error: ${JSON.stringify(e)}`);
        done = true;
      }
    }
    // cursor.release();
    callback(null);
  }

  async search(query, maxCount, tag, withContent, variantNames, callback) {
    let svc = await this.service;
    let cursor = await svc.search(query, maxCount, tag);
    await this.processCursor(cursor, withContent, variantNames, callback);
    cursor = null;
  }

  // Returns the top frequent items with a callback interface.
  async topByFrecency(maxCount, callback) {
    let svc = await this.service;
    let start = Date.now();
    let cursor = await svc.topByFrecency(maxCount);
    console.log(`IIII topByFrecency cursor: ${Date.now() - start}ms`);
    await this.processCursor(cursor, true, ["icon", "poster"], callback);
    console.log(`IIII topByFrecency full: ${Date.now() - start}ms`);
  }

  // Returns the last modified items with a callback interface.
  async lastModified(maxCount, callback) {
    let svc = await this.service;
    let start = Date.now();
    let cursor = await svc.lastModified(maxCount);
    console.log(`IIII lastModified cursor: ${Date.now() - start}ms`);
    await this.processCursor(cursor, true, ["icon", "poster"], callback);
    console.log(`IIII lastModified full: ${Date.now() - start}ms`);
  }

  async searchPlaces(query, maxCount, callback) {
    return this.search(query, maxCount, "places", true, ["icon"], callback);
  }

  async searchMedia(query, maxCount, callback) {
    return this.search(
      query,
      maxCount,
      "media",
      true,
      ["icon", "poster"],
      callback
    );
  }
}

// Wrapper class around a content manager resource.
class ContentResource {
  constructor(service, http_key, meta, blob, variant) {
    // console.log(`ContentResource::constructor http_key=${http_key}`);
    this._svc = service;
    this._meta = meta;
    this._http_key = http_key;
    this._variants = new Map();
    if (blob && variant) {
      this._variants.set(variant, blob);
    }
  }

  log(msg) {
    console.log(`ContentResource: ${msg}`);
  }

  error(msg) {
    console.error(`ContentResource: ${msg}`);
  }

  variant(name = "default") {
    return this._variants.get(name);
  }

  get meta() {
    return this._meta;
  }

  async update(blob, variant = "default") {
    await this._svc.updateVariant(this._meta.id, variant, blob);
    this._variants.set(variant, blob);
  }

  async updateVariantFromUrl(url, variant) {
    this.log(`updateVariantFromUrl '${variant}' ${url}`);
    if (!url) {
      this.error(`Mandatory 'url' parameter missing!`);
      return;
    }

    if (!variant) {
      this.error(`Mandatory 'variant' parameter missing!`);
      return;
    }

    try {
      let resource = await fetch(url);
      let blob = await resource.blob();
      await this.update(blob, variant);
    } catch (e) {
      this.error(
        `Error updating '${variant}' from '${url}' : ${JSON.stringify(e)}`
      );
    }
  }

  async delete() {
    await this._svc.delete(this._meta.id);
    this._variants.clear();
    this._meta = null;
  }

  async observe(callback) {
    try {
      await this._svc.addObserver(this._meta.id, callback);
    } catch (e) {
      this.error(`Failed to add observer for ${this._meta.id}: ${e}`);
    }
  }

  variantUrl(variant = "default") {
    return `http://127.0.0.1:${window.config.port}/cmgr/${this._http_key}/${this._meta.id}/${variant}`;
  }

  debug() {
    return JSON.stringify(this._meta || "<no meta>");
  }
}

class PluginsManager extends ContentManager {
  constructor(updatedCallback = null) {
    super();
    this.plugins = [];
    this.container = null;
    if (updatedCallback && typeof updatedCallback === "function") {
      this.onupdated = updatedCallback;
    }
  }

  log(msg) {
    console.log(`PluginsManager: ${msg}`);
  }

  error(msg) {
    console.error(`PluginsManager: ${msg}`);
  }

  async ready() {
    if (!this.container) {
      this.container = await this.ensureTopLevelContainer("wasm-plugins");
      this.svc = await this.service;
      this.lib = await this.lib();
      await this.ensureHttpKey(this.svc);
    }
  }

  async onchange(change) {
    this.log(`plugin list modified: ${JSON.stringify(change)}`);
    await this.update();
  }

  async init() {
    await this.ready();

    await this.svc.addObserver(this.container, this.onchange.bind(this));
    await this.update();
  }

  // Refresh the list of plugins.
  async update() {
    let cursor = await this.svc.childrenOf(this.container);

    this.list = [];
    let done = false;
    while (!done) {
      try {
        let children = await cursor.next();
        for (let child of children) {
          if (child.kind === this.lib.ResourceKind.LEAF) {
            let blob = await this.svc.getVariant(child.id, "default");
            this.list.push(
              new ContentResource(
                this.svc,
                this.http_key,
                child,
                blob,
                "default"
              )
            );
          }
        }
      } catch (e) {
        // cursor.next() rejects when no more items are available, so it's not
        // a fatal error.
        done = true;
      }
    }

    this.log(`list updated: ${this.list.length} items.`);
    if (this.onupdated) {
      this.onupdated(this.list);
    }
  }

  // Add a new plugin from a url.
  async add(json, url) {
    await this.ready();

    try {
      // Fetch the plugin as a blob and verify the content type.
      let plugin = await fetch(url);
      let blob = await plugin.blob();
      if (blob.type !== "application/wasm") {
        this.error(
          `Expected 'application/wasm' content type for ${url}, but got '${blob.type}'`
        );
        return;
      }

      // Store the new resource.
      let meta = await this.svc.createobj(
        {
          parent: this.container,
          name: url,
          kind: this.lib.ResourceKind.LEAF,
          tags: [],
        },
        "default",
        new Blob([JSON.stringify(json)], { type: "application/json" })
      );
      let resource = new ContentResource(this.svc, this.http_key, meta);
      await resource.update(blob, "wasm");

      await this.update();
    } catch (e) {
      this.error(`Failed to add plugin: ${e}`);
    }
  }
}
