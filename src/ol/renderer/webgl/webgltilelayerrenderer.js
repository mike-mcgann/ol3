// FIXME large resolutions lead to too large framebuffers :-(
// FIXME animated shaders! check in redraw

goog.provide('ol.renderer.webgl.TileLayer');

goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.object');
goog.require('goog.vec.Mat4');
goog.require('goog.vec.Vec4');
goog.require('goog.webgl');
goog.require('ol.Tile');
goog.require('ol.TileRange');
goog.require('ol.TileState');
goog.require('ol.extent');
goog.require('ol.layer.Tile');
goog.require('ol.math');
goog.require('ol.renderer.webgl.Layer');
goog.require('ol.renderer.webgl.tilelayer.shader');
goog.require('ol.source.Tile');
goog.require('ol.structs.Buffer');



/**
 * @constructor
 * @extends {ol.renderer.webgl.Layer}
 * @param {ol.renderer.Map} mapRenderer Map renderer.
 * @param {ol.layer.Tile} tileLayer Tile layer.
 */
ol.renderer.webgl.TileLayer = function(mapRenderer, tileLayer) {

  goog.base(this, mapRenderer, tileLayer);
  this.tileLayer_ = tileLayer;
  this.dirty_ = false;
  var self = this;
  this.tileLayer_.on("change:lookup", function() {
    self.dirty_ = true;
  });

  /**
   * @private
   * @type {ol.webgl.shader.Fragment}
   */
  this.fragmentShader_ =
      ol.renderer.webgl.tilelayer.shader.Fragment.getInstance();

  /**
   * @private
   * @type {ol.webgl.shader.Vertex}
   */
  this.vertexShader_ = ol.renderer.webgl.tilelayer.shader.Vertex.getInstance();

  /**
   * @private
   * @type {ol.renderer.webgl.tilelayer.shader.Locations}
   */
  this.locations_ = null;

  /**
   * @private
   * @type {ol.structs.Buffer}
   */
  this.renderArrayBuffer_ = new ol.structs.Buffer([
    0, 0, 0, 1,
    1, 0, 1, 1,
    0, 1, 0, 0,
    1, 1, 1, 0
  ]);

  /**
   * @private
   * @type {ol.TileRange}
   */
  this.renderedTileRange_ = null;

  /**
   * @private
   * @type {ol.Extent}
   */
  this.renderedFramebufferExtent_ = null;

  /**
   * @private
   * @type {number}
   */
  this.renderedRevision_ = -1;

};
goog.inherits(ol.renderer.webgl.TileLayer, ol.renderer.webgl.Layer);


/**
 * @inheritDoc
 */
ol.renderer.webgl.TileLayer.prototype.disposeInternal = function() {
  var mapRenderer = this.getWebGLMapRenderer();
  var context = mapRenderer.getContext();
  context.deleteBuffer(this.renderArrayBuffer_);
  goog.base(this, 'disposeInternal');
};


/**
 * @inheritDoc
 */
ol.renderer.webgl.TileLayer.prototype.handleWebGLContextLost = function() {
  goog.base(this, 'handleWebGLContextLost');
  this.locations_ = null;
};


/**
 * @inheritDoc
 */
ol.renderer.webgl.TileLayer.prototype.prepareFrame =
    function(frameState, layerState) {

  var mapRenderer = this.getWebGLMapRenderer();
  var context = mapRenderer.getContext();
  var gl = mapRenderer.getGL();

  var view2DState = frameState.view2DState;
  var projection = view2DState.projection;

  var tileLayer = this.getLayer();
  goog.asserts.assertInstanceof(tileLayer, ol.layer.Tile);
  var tileSource = tileLayer.getSource();
  goog.asserts.assertInstanceof(tileSource, ol.source.Tile);
  var tileGrid = tileSource.getTileGridForProjection(projection);
  var z = tileGrid.getZForResolution(view2DState.resolution);
  var tileResolution = tileGrid.getResolution(z);

  var tilePixelSize =
      tileSource.getTilePixelSize(z, frameState.pixelRatio, projection);
  var pixelRatio = tilePixelSize / tileGrid.getTileSize(z);
  var tilePixelResolution = tileResolution / pixelRatio;
  var tileGutter = tileSource.getGutter();

  var center = view2DState.center;
  var extent;
  if (tileResolution == view2DState.resolution) {
    center = this.snapCenterToPixel(center, tileResolution, frameState.size);
    extent = ol.extent.getForView2DAndSize(
        center, tileResolution, view2DState.rotation, frameState.size);
  } else {
    extent = frameState.extent;
  }
  var tileRange = tileGrid.getTileRangeForExtentAndResolution(
      extent, tileResolution);

  var framebufferExtent;
  if (!this.dirty_ && !goog.isNull(this.renderedTileRange_) &&
      this.renderedTileRange_.equals(tileRange) &&
      this.renderedRevision_ == tileSource.getRevision()) {
    framebufferExtent = this.renderedFramebufferExtent_;
  } else {
    this.dirty_ = false;
    var tileRangeSize = tileRange.getSize();

    var maxDimension = Math.max(
        tileRangeSize[0] * tilePixelSize, tileRangeSize[1] * tilePixelSize);
    var framebufferDimension = ol.math.roundUpToPowerOfTwo(maxDimension);
    var framebufferExtentDimension = tilePixelResolution * framebufferDimension;
    var origin = tileGrid.getOrigin(z);
    var minX = origin[0] + tileRange.minX * tilePixelSize * tilePixelResolution;
    var minY = origin[1] + tileRange.minY * tilePixelSize * tilePixelResolution;
    framebufferExtent = [
      minX, minY,
      minX + framebufferExtentDimension, minY + framebufferExtentDimension
    ];

    this.bindFramebuffer(frameState, framebufferDimension);
    gl.viewport(0, 0, framebufferDimension, framebufferDimension);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(goog.webgl.COLOR_BUFFER_BIT);
    gl.disable(goog.webgl.BLEND);

    var program = context.getProgram(this.fragmentShader_, this.vertexShader_);
    context.useProgram(program);
    if (goog.isNull(this.locations_)) {
      this.locations_ =
          new ol.renderer.webgl.tilelayer.shader.Locations(gl, program);
    }

    context.bindBuffer(goog.webgl.ARRAY_BUFFER, this.renderArrayBuffer_);
    gl.enableVertexAttribArray(this.locations_.a_position);
    gl.vertexAttribPointer(
        this.locations_.a_position, 2, goog.webgl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.locations_.a_texCoord);
    gl.vertexAttribPointer(
        this.locations_.a_texCoord, 2, goog.webgl.FLOAT, false, 16, 8);
    gl.uniform1i(this.locations_.u_texture, 0);
    var lookup = this.tileLayer_.getLookup();
    if ( lookup ) {
        gl.uniform1i(this.locations_.u_enabled, 1);
         // Source map
        gl.uniform1i(this.locations_.u_sourceMap, 1);
        var sourceMap = new Uint8Array(256 * 4);
        var sourceColors = lookup.source;
        for ( var i = 0; i < 256; i++ ) {
            var sc;
            if ( i < sourceColors.length ) {
                sc = sourceColors[i] + "ff";
            } else {
                sc = "00000000";
            }
            sourceMap[i * 4 + 0] = parseInt(sc.substr(0, 2), 16);
            sourceMap[i * 4 + 1] = parseInt(sc.substr(2, 2), 16);
            sourceMap[i * 4 + 2] = parseInt(sc.substr(4, 2), 16);
            sourceMap[i * 4 + 3] = parseInt(sc.substr(6, 2), 16);
        }
        gl.activeTexture(gl.TEXTURE1);
        var sourceMapTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, sourceMapTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, sourceMap);

        // Target Map
        gl.uniform1i(this.locations_.u_targetMap, 2);
        var targetMap = new Uint8Array(256 * 4);
        var targetColors = lookup.target;
        for ( var i = 0; i < targetColors.length; i++ ) {
            var tc;
            if ( i < targetColors.length ) {
                tc = targetColors[i];
            } else {
                tc = "000000";
            }
            targetMap[i * 4 + 0] = parseInt(tc.substr(0, 2), 16);
            targetMap[i * 4 + 1] = parseInt(tc.substr(2, 2), 16);
            targetMap[i * 4 + 2] = parseInt(tc.substr(4, 2), 16);
            targetMap[i * 4 + 3] = sourceMap[i * 4 + 3];
        }
        window.console.log(sourceMap, targetMap);
        //origTarget = new Uint8Array(265 * 4);
        gl.activeTexture(gl.TEXTURE2);
        var targetMapTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, targetMapTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, targetMap);

        gl.activeTexture(gl.TEXTURE0);
    } else {
        gl.uniform1i(this.locations_.u_enabled, 0);
    }

    /**
     * @type {Object.<number, Object.<string, ol.Tile>>}
     */
    var tilesToDrawByZ = {};
    tilesToDrawByZ[z] = {};

    var getTileIfLoaded = this.createGetTileIfLoadedFunction(function(tile) {
      return !goog.isNull(tile) && tile.getState() == ol.TileState.LOADED &&
          mapRenderer.isTileTextureLoaded(tile);
    }, tileSource, pixelRatio, projection);
    var findLoadedTiles = goog.bind(tileSource.findLoadedTiles, tileSource,
        tilesToDrawByZ, getTileIfLoaded);

    var allTilesLoaded = true;
    var tmpExtent = ol.extent.createEmpty();
    var tmpTileRange = new ol.TileRange(0, 0, 0, 0);
    var childTileRange, fullyLoaded, tile, tileState, x, y;
    for (x = tileRange.minX; x <= tileRange.maxX; ++x) {
      for (y = tileRange.minY; y <= tileRange.maxY; ++y) {

        tile = tileSource.getTile(z, x, y, pixelRatio, projection);
        tileState = tile.getState();
        if (tileState == ol.TileState.LOADED) {
          if (mapRenderer.isTileTextureLoaded(tile)) {
            tilesToDrawByZ[z][tile.tileCoord.toString()] = tile;
            continue;
          }
        } else if (tileState == ol.TileState.ERROR ||
                   tileState == ol.TileState.EMPTY) {
          continue;
        }

        allTilesLoaded = false;
        fullyLoaded = tileGrid.forEachTileCoordParentTileRange(
            tile.tileCoord, findLoadedTiles, null, tmpTileRange, tmpExtent);
        if (!fullyLoaded) {
          childTileRange = tileGrid.getTileCoordChildTileRange(
              tile.tileCoord, tmpTileRange, tmpExtent);
          if (!goog.isNull(childTileRange)) {
            findLoadedTiles(z + 1, childTileRange);
          }
        }

      }

    }

    /** @type {Array.<number>} */
    var zs = goog.array.map(goog.object.getKeys(tilesToDrawByZ), Number);
    goog.array.sort(zs);
    var u_tileOffset = goog.vec.Vec4.createFloat32();
    var i, ii, sx, sy, tileExtent, tileKey, tilesToDraw, tx, ty;
    for (i = 0, ii = zs.length; i < ii; ++i) {
      tilesToDraw = tilesToDrawByZ[zs[i]];
      for (tileKey in tilesToDraw) {
        tile = tilesToDraw[tileKey];
        tileExtent = tileGrid.getTileCoordExtent(tile.tileCoord, tmpExtent);
        sx = 2 * (tileExtent[2] - tileExtent[0]) /
            framebufferExtentDimension;
        sy = 2 * (tileExtent[3] - tileExtent[1]) /
            framebufferExtentDimension;
        tx = 2 * (tileExtent[0] - framebufferExtent[0]) /
            framebufferExtentDimension - 1;
        ty = 2 * (tileExtent[1] - framebufferExtent[1]) /
            framebufferExtentDimension - 1;
        goog.vec.Vec4.setFromValues(u_tileOffset, sx, sy, tx, ty);
        gl.uniform4fv(this.locations_.u_tileOffset, u_tileOffset);
        mapRenderer.bindTileTexture(tile, tilePixelSize,
            tileGutter * pixelRatio, goog.webgl.LINEAR, goog.webgl.LINEAR);
        gl.drawArrays(goog.webgl.TRIANGLE_STRIP, 0, 4);
      }
    }

    if (allTilesLoaded) {
      this.renderedTileRange_ = tileRange;
      this.renderedFramebufferExtent_ = framebufferExtent;
      this.renderedRevision_ = tileSource.getRevision();
    } else {
      this.renderedTileRange_ = null;
      this.renderedFramebufferExtent_ = null;
      this.renderedRevision_ = -1;
      frameState.animate = true;
    }

  }

  this.updateUsedTiles(frameState.usedTiles, tileSource, z, tileRange);
  var tileTextureQueue = mapRenderer.getTileTextureQueue();
  this.manageTilePyramid(
      frameState, tileSource, tileGrid, pixelRatio, projection, extent, z,
      tileLayer.getPreload(),
      /**
       * @param {ol.Tile} tile Tile.
       */
      function(tile) {
        if (tile.getState() == ol.TileState.LOADED &&
            !mapRenderer.isTileTextureLoaded(tile) &&
            !tileTextureQueue.isKeyQueued(tile.getKey())) {
          tileTextureQueue.enqueue([
            tile,
            tileGrid.getTileCoordCenter(tile.tileCoord),
            tileGrid.getResolution(tile.tileCoord.z),
            tilePixelSize, tileGutter * pixelRatio
          ]);
        }
      }, this);
  this.scheduleExpireCache(frameState, tileSource);
  this.updateLogos(frameState, tileSource);

  var texCoordMatrix = this.texCoordMatrix;
  goog.vec.Mat4.makeIdentity(texCoordMatrix);
  goog.vec.Mat4.translate(texCoordMatrix,
      (center[0] - framebufferExtent[0]) /
          (framebufferExtent[2] - framebufferExtent[0]),
      (center[1] - framebufferExtent[1]) /
          (framebufferExtent[3] - framebufferExtent[1]),
      0);
  if (view2DState.rotation !== 0) {
    goog.vec.Mat4.rotateZ(texCoordMatrix, view2DState.rotation);
  }
  goog.vec.Mat4.scale(texCoordMatrix,
      frameState.size[0] * view2DState.resolution /
          (framebufferExtent[2] - framebufferExtent[0]),
      frameState.size[1] * view2DState.resolution /
          (framebufferExtent[3] - framebufferExtent[1]),
      1);
  goog.vec.Mat4.translate(texCoordMatrix,
      -0.5,
      -0.5,
      0);

};
