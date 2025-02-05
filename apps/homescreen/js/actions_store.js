// This class manages the persistence of the actions displayed on the homescreen.

class ActionsStore extends EventTarget {
  constructor() {
    super();

    this.actions = [];

    this.init().then(() => {
      this.log(`Store ready`);
      this.dispatchEvent(new CustomEvent("store-ready"));
    });
  }

  log(msg) {
    console.log(`ActionsStore ${msg}`);
  }

  error(msg) {
    console.error(`ActionsStore ${msg}`);
  }

  fetchAsBlob(url) {
    return new Promise((resolve, reject) => {
      // We can't use fetch() since there it doesn't support mozSystem yet.
      let xhr = new XMLHttpRequest({ mozSystem: true });
      xhr.open("GET", url, true);
      xhr.responseType = "blob";

      xhr.onerror = reject;
      xhr.onload = () => {
        if (xhr.response !== null) {
          resolve(xhr.response);
        } else {
          reject(
            new Error(`Failed to fetch ${url}: ${xhr.status} ${xhr.statusText}`)
          );
        }
      };

      xhr.send();
    });
  }

  async loadActions() {
    // Get the children of the current folder.
    let cursor = await this.svc.childrenOf(this.container);
    let results = [];

    let done = false;
    while (!done) {
      try {
        let children = await cursor.next();
        for (let child of children) {
          let blob = await this.svc.getVariant(child.id);
          // Extract the json from the blob.
          const json = await new Response(blob).json();

          // If there is a icon variant, use it for the icon field.
          try {
            json.icon = await this.svc.getVariant(child.id, "icon");
          } catch (e) {}
          results.push(json);
        }
      } catch (e) {
        // cursor.next() rejects when no more items are available, so it's not
        // a fatal error.
        done = true;
      }
    }

    return results;
  }

  async loadOrUseDefaults(initEmpty) {
    this.log(`loadOrUseDefaults initEmpty=${initEmpty}`);

    this.actions = await this.loadActions();
    if (initEmpty) {
      this.log(
        `No actions in 'homescreen' container, loading from default values.`
      );
      this.actions = await fetch("./resources/default/actions.json").then(
        (response) => response.json()
      );

      // Load icons and convert them into Blobs, and substitues port number in urls.
      let fetches = [];
      for (let action of this.actions) {
        action.url = action.url.replaceAll(
          "__LOCAL_PORT__",
          window.config.port
        );
        fetches.push(this.fetchAsBlob(action.icon));
      }
      let blobs = await Promise.all(fetches);
      let i = 0;
      for (let action of this.actions) {
        action.icon = blobs[i];
        i += 1;
      }

      this.saveAll();
    }
  }

  // Creates or update an action resource.
  // The action id is used as the resource name.
  async updateAction(action) {
    let entry = await contentManager.childByName(this.container, action.id);
    let content = new Blob([JSON.stringify(action)], {
      type: "application/json",
    });
    if (entry) {
      await entry.update(content);
    } else {
      entry = await contentManager.create(
        this.container,
        action.id,
        content,
        []
      );
    }

    // Save the icon as a variant.
    if (Object.getPrototypeOf(action.icon) === Blob.prototype) {
      await entry.update(action.icon, "icon");
    }
  }

  async saveAll() {
    for (let action of this.actions) {
      await this.updateAction(action);
    }
  }

  async removeAction(actionId) {
    let index = this.actions.findIndex((action) => {
      return action.id === actionId;
    });
    if (index !== -1) {
      this.actions.splice(index, 1);
      try {
        let meta = await this.svc.getChildByName(actionId);
        await this.svc.delete(meta.id);
      } catch (e) {}
    } else {
      console.error(`No action with id '${actionId}' to remove.`);
    }
  }

  getActionById(actionId) {
    return this.actions.find((action) => {
      return action.id === actionId;
    });
  }

  getActionByManifestUrl(manifestUrl) {
    return this.actions.find((action) => {
      return action.app === manifestUrl;
    });
  }

  async addAction(action) {
    this.actions.push(action);
    await this.updateAction(action);
  }

  forEach(callback) {
    this.actions.forEach(callback);
  }

  async init() {
    this.log(`init`);

    this.svc = await contentManager.getService();

    const alreadyCreated = await contentManager.hasTopLevelContainer(
      "homescreen"
    );

    this.container = await contentManager.ensureTopLevelContainer("homescreen");

    return await this.loadOrUseDefaults(!alreadyCreated);
  }

  // Returns the list of empty 1x1 slots in the wall.
  getEmptySlots(width) {
    // Set the minimum height to 10 to let enough moving space.
    let maxHeight = 10;
    let slots = new Set();
    this.actions.forEach((action) => {
      let [x, y] = action.position.split(",");
      x = x | 0;
      y = y | 0;
      if (y > maxHeight) {
        maxHeight = y;
      }
      let position = `${x},${y}`;
      slots.add(position);
    });

    // Add an empty row at the top: add 2 because we are 0 based.
    maxHeight += 2;

    let result = new Set();
    for (let y = 0; y < maxHeight; y++) {
      for (let x = 0; x < width; x++) {
        let position = `${x},${y}`;
        if (!slots.has(position)) {
          result.add(position);
        }
      }
    }
    return result;
  }

  updatePositionFor(id, position) {
    this.actions.forEach((action) => {
      if (action.id === id) {
        action.position = position;
        this.updateAction(action);
      }
    });
  }
}
