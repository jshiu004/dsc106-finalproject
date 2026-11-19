/* Beyond the Average: one state drives scrolling, controls, maps, and bars. */
(() => {
  'use strict';
  const { d3, topojson, scrollama } = window;
  const $ = (selector) => document.querySelector(selector);
  const seasons = { annual: 'Annual average', DJF: 'December–February', MAM: 'March–May', JJA: 'June–August', SON: 'September–November' };
  const northId = 'lat_60_90';
  const storyStates = [
    { season: 'annual', region: 'global' },
    { season: 'annual', region: northId },
    { season: 'DJF', region: northId },
    { season: 'JJA', region: northId },
    { season: 'annual', region: 'global' },
  ];
  const state = { ...storyStates[0], step: 0, manual: false, usSeason: 'annual' };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const compactLayout = matchMedia('(max-width: 56rem), (max-height: 50rem)');
  let grid, summary, color, colorMax, chartMax, worldMap, usMap, chart, scroller;
  let bandRows, xScale, chartWidth = 0;
  const steps = [...document.querySelectorAll('.story-step')];

  function fail(message, error) {
    $('#explorer-status').textContent = message;
    $('#explorer-status').classList.add('load-error');
    console.error(message, error);
  }

  async function loadJSON(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  }

  function addLegend(selector) {
    const host = d3.select(selector);
    host.append('div').attr('class', 'legend-caption').append('span').text('Projected temperature increase (°C)');
    const gradient = Array.from({ length: 21 }, (_, i) => `${color(i * colorMax / 20)} ${i * 5}%`).join(',');
    host.append('div').attr('class', 'legend-gradient').style('background', `linear-gradient(to right, ${gradient})`);
    const ticks = host.append('div').attr('class', 'legend-caption');
    d3.range(0, colorMax + .1, colorMax / 4).forEach(value => ticks.append('span').text(`${d3.format('~g')(value)}°`));
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'map-tooltip';
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip');
  document.body.append(tooltip);

  function createWorldMap(countries) {
    const width = 960, height = 500;
    const host = d3.select('#warming-map');
    host.selectAll('*').remove();
    const frame = host.append('div').attr('class', 'map-frame equal-earth-frame');
    const canvas = frame.append('canvas').attr('width', width).attr('height', height)
      .attr('role', 'img');
    const context = canvas.node().getContext('2d');
    const projection = d3.geoEqualEarth().fitExtent([[12, 10], [width - 12, height - 10]], { type: 'Sphere' });
    const path = d3.geoPath(projection);
    const spherePath = path({ type: 'Sphere' });
    const sphere = new Path2D(spherePath);
    const overlay = frame.append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('aria-hidden', 'true');
    overlay.append('defs').append('clipPath').attr('id', 'world-sphere-clip').append('path').attr('d', spherePath);
    const globe = overlay.append('g').attr('clip-path', 'url(#world-sphere-clip)');
    globe.append('path').datum(d3.geoGraticule().step([30, 30])()).attr('class', 'map-graticule').attr('d', path);
    globe.append('path').datum(topojson.mesh(countries, countries.objects.countries)).attr('class', 'map-outline').attr('d', path);
    const masks = globe.append('g');
    const highlight = globe.append('path').attr('class', 'band-highlight').attr('visibility', 'hidden');
    overlay.append('path').attr('d', spherePath).attr('class', 'sphere-outline');

    // Equal Earth parallels are horizontal. Precompute each screen pixel's original
    // grid cell once, sampling the inverse projection at the pixel center.
    const columns = grid.grid.longitudes.length;
    const rows = grid.grid.latitudes.length;
    const cellIndices = new Int32Array(width * height).fill(-1);
    const top = projection([0, 90])[1], bottom = projection([0, -90])[1];
    for (let py = 0; py < height; py++) {
      const sy = py + .5;
      if (sy < top || sy > bottom) continue;
      const latitude = projection.invert([width / 2, sy])[1];
      const left = projection([-180, latitude])[0], right = projection([180, latitude])[0];
      const row = Math.min(rows - 1, Math.floor((latitude + 90) / 1.25));
      for (let px = Math.max(0, Math.ceil(left - .5)); px < Math.min(width, right - .5); px++) {
        const longitude = (px + .5 - left) / (right - left) * 360 - 180;
        const col = Math.min(columns - 1, Math.floor((longitude + 180) / 1.875));
        cellIndices[py * width + px] = row * columns + col;
      }
    }

    // Trace parallels and curved outer meridians, avoiding spherical polygon
    // orientation and antimeridian ambiguity for a full-width latitude band.
    function bandPath(lower, upper) {
      const shape = d3.path();
      const point = coordinates => projection(coordinates);
      shape.moveTo(...point([-180, upper]));
      shape.lineTo(...point([180, upper]));
      for (let latitude = upper; latitude > lower; latitude -= .5) shape.lineTo(...point([180, latitude]));
      shape.lineTo(...point([180, lower]));
      shape.lineTo(...point([-180, lower]));
      for (let latitude = lower; latitude < upper; latitude += .5) shape.lineTo(...point([-180, latitude]));
      shape.closePath();
      return shape.toString();
    }

    const cache = new Map();
    let currentSeason = null, currentLayer = null, animation = null;
    function seasonLayer(season) {
      if (cache.has(season)) return cache.get(season);
      const layer = document.createElement('canvas');
      layer.width = width; layer.height = height;
      const draw = layer.getContext('2d');
      const pixels = draw.createImageData(width, height);
      const palette = grid.warming[season].map(value => d3.rgb(color(value)));
      for (let pixel = 0; pixel < cellIndices.length; pixel++) {
        const index = cellIndices[pixel];
        if (index < 0) continue;
        const rgb = palette[index];
        const offset = pixel * 4;
        pixels.data[offset] = rgb.r; pixels.data[offset + 1] = rgb.g;
        pixels.data[offset + 2] = rgb.b; pixels.data[offset + 3] = 255;
      }
      draw.putImageData(pixels, 0, 0);
      cache.set(season, layer);
      return layer;
    }

    function update(season, region = 'global') {
      tooltip.hidden = true;
      if (season !== currentSeason) {
        animation?.stop();
        const previous = currentLayer;
        currentLayer = seasonLayer(season);
        const paint = fraction => {
          context.clearRect(0, 0, width, height);
          if (previous && fraction < 1) context.drawImage(previous, 0, 0);
          context.globalAlpha = fraction;
          context.drawImage(currentLayer, 0, 0);
          context.globalAlpha = 1;
        };
        if (previous && !reducedMotion.matches) {
          animation = d3.timer(elapsed => {
            const fraction = Math.min(1, elapsed / 350);
            paint(d3.easeCubicInOut(fraction));
            if (fraction === 1) { animation.stop(); animation = null; }
          });
        } else paint(1);
        currentSeason = season;
      }
      const band = summary.bands.find(d => d.id === region);
      const shaded = band ? [[-90, band.latitude_min], [band.latitude_max, 90]].filter(([lo, hi]) => hi > lo) : [];
      masks.selectAll('path').data(shaded).join('path').attr('class', 'outside-band').attr('d', ([lo, hi]) => bandPath(lo, hi));
      highlight.attr('visibility', band ? 'visible' : 'hidden').attr('d', band ? bandPath(band.latitude_min, band.latitude_max) : null);
      canvas.attr('aria-label', `Equal Earth world map: ${seasons[season]} projected warming, 2081–2100 relative to 1995–2014. Land and ocean. Fixed scale 0 to ${colorMax}°C.${band ? ` Highlighted band: ${band.label}.` : ''} Use the latitude selector for a keyboard alternative.`);
    }

    function locate(event) {
      const rect = canvas.node().getBoundingClientRect();
      const px = (event.clientX - rect.left) * width / rect.width;
      const py = (event.clientY - rect.top) * height / rect.height;
      if (!context.isPointInPath(sphere, px, py)) return null;
      const [longitude, latitude] = projection.invert([px, py]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) return null;
      const row = Math.min(rows - 1, Math.max(0, Math.floor((latitude + 90) / 1.25)));
      const col = Math.min(columns - 1, Math.max(0, Math.floor((longitude + 180) / 1.875)));
      return { row, col, latitude };
    }
    canvas.on('pointermove', event => {
      const cell = locate(event);
      if (!cell || event.pointerType === 'touch') { tooltip.hidden = true; return; }
      const latitude = grid.grid.latitudes[cell.row], longitude = grid.grid.longitudes[cell.col];
      const value = grid.warming[currentSeason][cell.row * columns + cell.col];
      tooltip.textContent = `${Math.abs(latitude).toFixed(2)}°${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(2)}°${longitude < 0 ? 'W' : 'E'} · ${seasons[currentSeason]}: +${value.toFixed(2)}°C`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, innerWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, innerHeight - tooltip.offsetHeight - 8))}px`;
    }).on('pointerleave', () => { tooltip.hidden = true; });
    canvas.on('click', event => {
      const cell = locate(event);
      if (!cell) return;
      const band = summary.bands.find(d => cell.latitude >= d.latitude_min && cell.latitude < d.latitude_max);
      if (band) explore({ region: band.id });
    });
    return { update };
  }

  function createMap(selector, bounds, countries, states) {
    const [west, east, south, north] = bounds;
    const width = 960;
    const height = width * (north - south) / (east - west);
    const host = d3.select(selector);
    host.selectAll('*').remove();
    const frame = host.append('div').attr('class', 'map-frame');
    const canvas = frame.append('canvas').attr('width', width).attr('height', Math.ceil(height))
      .attr('role', 'img').attr('aria-label', 'Projected warming map. Use the labeled controls for regional and seasonal comparisons.');
    const context = canvas.node().getContext('2d');
    const overlay = frame.append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('aria-hidden', 'true');
    const projection = d3.geoEquirectangular().scale(width / ((east - west) * Math.PI / 180))
      .center([(west + east) / 2, (south + north) / 2]).translate([width / 2, height / 2]);
    const path = d3.geoPath(projection);
    overlay.append('path').datum(d3.geoGraticule10()).attr('class', 'map-graticule').attr('d', path);
    overlay.append('path').datum(topojson.mesh(countries, countries.objects.countries))
      .attr('class', 'map-outline').attr('d', path);
    if (states) overlay.append('path').datum(topojson.mesh(states, states.objects.states, (a, b) => a !== b))
      .attr('class', 'map-outline').attr('d', path);
    const masks = overlay.append('g');
    const highlight = overlay.append('rect').attr('class', 'band-highlight').attr('x', 0).attr('width', width).attr('visibility', 'hidden');
    const x = d3.scaleLinear().domain([west, east]).range([0, width]);
    const y = d3.scaleLinear().domain([north, south]).range([0, height]);
    const raster = document.createElement('canvas');
    raster.width = grid.grid.longitudes.length;
    raster.height = grid.grid.latitudes.length;
    const rasterContext = raster.getContext('2d');
    const rasterCache = new Map();
    let currentSeason = null;

    function update(season, region = 'global') {
      if (currentSeason !== season) {
        if (!rasterCache.has(season)) {
          const pixels = rasterContext.createImageData(raster.width, raster.height);
          const values = grid.warming[season];
          for (let row = 0; row < raster.height; row++) {
            for (let col = 0; col < raster.width; col++) {
              const value = values[(raster.height - row - 1) * raster.width + col];
              const rgb = d3.rgb(color(value));
              const pixel = (row * raster.width + col) * 4;
              pixels.data.set([rgb.r, rgb.g, rgb.b, 255], pixel);
            }
          }
          rasterCache.set(season, pixels);
        }
        rasterContext.putImageData(rasterCache.get(season), 0, 0);
        context.clearRect(0, 0, width, Math.ceil(height));
        context.imageSmoothingEnabled = false;
        // Crop the same full global raster for both views, preserving original cell locations.
        const sx = (west + 180) / 360 * raster.width;
        const sy = (90 - north) / 180 * raster.height;
        context.drawImage(raster, sx, sy, (east - west) / 360 * raster.width,
          (north - south) / 180 * raster.height, 0, 0, width, height);
        currentSeason = season;
      }
      const band = summary.bands.find(d => d.id === region);
      const shaded = band ? [
        { y: 0, height: Math.max(0, y(band.latitude_max)) },
        { y: y(band.latitude_min), height: Math.max(0, height - y(band.latitude_min)) },
      ] : [];
      masks.selectAll('rect').data(shaded).join('rect').attr('class', 'outside-band')
        .attr('x', 0).attr('width', width).attr('y', d => d.y).attr('height', d => d.height);
      highlight.attr('visibility', band ? 'visible' : 'hidden');
      if (band) highlight.attr('y', y(band.latitude_max)).attr('height', y(band.latitude_min) - y(band.latitude_max));
      canvas.attr('aria-label', `${selector === '#us-map' ? 'Contiguous US area' : 'World'} map: ${seasons[season]} projected warming, 2081–2100 relative to 1995–2014. Fixed scale 0 to ${colorMax}°C.${band ? ` Highlighted band: ${band.label}.` : ''}`);
    }

    function location(event) {
      const rect = canvas.node().getBoundingClientRect();
      const longitude = west + (event.clientX - rect.left) / rect.width * (east - west);
      const latitude = north - (event.clientY - rect.top) / rect.height * (north - south);
      const row = d3.bisectCenter(grid.grid.latitudes, latitude);
      const col = d3.bisectCenter(grid.grid.longitudes, longitude);
      return { latitude, longitude, row, col };
    }

    canvas.on('pointermove', event => {
      if (event.pointerType === 'touch') return;
      const point = location(event);
      const value = grid.warming[currentSeason][point.row * raster.width + point.col];
      const latitude = grid.grid.latitudes[point.row];
      const longitude = grid.grid.longitudes[point.col];
      tooltip.textContent = `${Math.abs(latitude).toFixed(2)}°${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(2)}°${longitude < 0 ? 'W' : 'E'} · ${seasons[currentSeason]}: +${value.toFixed(2)}°C`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, innerWidth - tooltip.offsetWidth - 8))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, innerHeight - tooltip.offsetHeight - 8))}px`;
    }).on('pointerleave', () => { tooltip.hidden = true; });
    if (selector === '#warming-map') canvas.on('click', event => {
      const { latitude } = location(event);
      const band = summary.bands.find(d => latitude >= d.latitude_min && latitude < d.latitude_max);
      if (band) explore({ region: band.id });
    });
    return { update };
  }

  function createChart() {
    const host = d3.select('#latitude-chart');
    host.selectAll('*').remove();
    chart = host.append('svg').attr('role', 'group').attr('aria-label', 'Latitude-band warming comparison. Each row is a button.');
    chart.append('g').attr('class', 'x-axis');
    const groups = chart.append('g').attr('class', 'band-rows');
    bandRows = groups.selectAll('.band-row').data([...summary.bands].reverse(), d => d.id).join('g')
      .attr('class', 'band-row').attr('role', 'button').attr('tabindex', 0)
      .on('click', (_, d) => explore({ region: state.region === d.id ? 'global' : d.id }))
      .on('keydown', (event, d) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          explore({ region: state.region === d.id ? 'global' : d.id });
        }
      });
    bandRows.append('rect').attr('class', 'row-hit').attr('fill', 'transparent');
    bandRows.append('rect').attr('class', 'band-bar');
    bandRows.append('text').attr('class', 'band-label').attr('text-anchor', 'end');
    bandRows.append('text').attr('class', 'band-value');
    chart.append('line').attr('class', 'global-reference');
    chart.append('text').attr('class', 'axis-unit').attr('text-anchor', 'end').text('°C');
    resizeChart();
    new ResizeObserver(resizeChart).observe(host.node());
  }

  function resizeChart() {
    const width = Math.max(280, Math.round($('#latitude-chart').clientWidth));
    if (width === chartWidth) return;
    chartWidth = width;
    const left = 100, right = 50, top = 6, rowHeight = 25, bottom = top + 6 * rowHeight;
    xScale = d3.scaleLinear().domain([0, chartMax]).range([left, width - right]);
    chart.attr('viewBox', `0 0 ${width} ${bottom + 30}`).attr('height', bottom + 30);
    chart.select('.x-axis').attr('transform', `translate(0,${bottom})`)
      .call(d3.axisBottom(xScale).ticks(4).tickSizeOuter(0));
    bandRows.attr('transform', (_, i) => `translate(0,${top + i * rowHeight})`);
    bandRows.select('.row-hit').attr('x', 1).attr('y', 0).attr('width', width - 2).attr('height', rowHeight - 1);
    bandRows.select('.band-bar').attr('x', left).attr('y', 4).attr('height', 16);
    bandRows.select('.band-label').attr('x', left - 10).attr('y', 16).text(d => d.label);
    bandRows.select('.band-value').attr('y', 16);
    chart.select('.global-reference').attr('y1', 2).attr('y2', bottom);
    chart.select('.axis-unit').attr('x', width - 2).attr('y', bottom + 20);
    updateChart(false);
  }

  function updateChart(animate = true) {
    if (!chart) return;
    const duration = animate && !reducedMotion.matches ? 350 : 0;
    bandRows.classed('is-selected', d => d.id === state.region)
      .attr('aria-pressed', d => String(d.id === state.region))
      .attr('aria-label', d => `${d.label}, ${seasons[state.season]}: +${d.warming[state.season].toFixed(2)}°C. Select latitude band.`);
    bandRows.select('.band-bar').interrupt().transition().duration(duration)
      .attr('width', d => xScale(d.warming[state.season]) - xScale(0));
    bandRows.select('.band-value').text(d => d.warming[state.season].toFixed(2)).interrupt()
      .transition().duration(duration).attr('x', d => xScale(d.warming[state.season]) + 6);
    chart.select('.global-reference').interrupt().transition().duration(duration)
      .attr('x1', xScale(summary.global[state.season])).attr('x2', xScale(summary.global[state.season]));
  }

  function render() {
    $('#season-select').value = state.season;
    $('#region-select').value = state.region;
    $('#map-season').textContent = seasons[state.season];
    $('#resume-story').hidden = !state.manual;
    $('#explorer-status').textContent = state.manual ? 'Exploring manually · Resume the story whenever you’re ready.'
      : state.step === 4 ? 'Your turn · Choose any region and season.' : `Guided story · ${state.step + 1} of ${steps.length}`;
    const band = summary.bands.find(d => d.id === state.region);
    const global = summary.global[state.season];
    $('#selection-summary').textContent = band
      ? `${band.label} · ${seasons[state.season]}: +${band.warming[state.season].toFixed(2)}°C · Global: +${global.toFixed(2)}°C`
      : `${seasons[state.season]} · Global average: +${global.toFixed(2)}°C`;
    worldMap.update(state.season, state.region);
    updateChart();
  }

  function explore(patch) {
    Object.assign(state, patch, { manual: true });
    render();
  }

  function setStory(index, scrollToStep = false) {
    state.step = Math.max(0, Math.min(steps.length - 1, index));
    Object.assign(state, storyStates[state.step], { manual: false });
    steps.forEach((step, i) => {
      step.classList.toggle('is-active', i === state.step);
      if (i === state.step) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
    $('#step-counter').textContent = `Story ${state.step + 1} of ${steps.length}`;
    $('#previous-step').disabled = state.step === 0;
    $('#next-step').disabled = state.step === steps.length - 1;
    render();
    if (scrollToStep && !compactLayout.matches) steps[state.step].scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  }

  function setupStory() {
    $('#season-select').addEventListener('change', event => explore({ season: event.target.value }));
    $('#region-select').addEventListener('change', event => explore({ region: event.target.value }));
    $('#resume-story').addEventListener('click', () => {
      if (!compactLayout.matches) {
        const trigger = innerHeight * .5;
        let active = 0;
        steps.forEach((step, i) => { if (step.getBoundingClientRect().top < trigger) active = i; });
        setStory(active);
      } else setStory(state.step);
    });
    $('#previous-step').addEventListener('click', () => setStory(state.step - 1, true));
    $('#next-step').addEventListener('click', () => setStory(state.step + 1, true));
    document.querySelectorAll('[data-show-step]').forEach(button => {
      button.disabled = false;
      button.addEventListener('click', () => setStory(Number(button.dataset.showStep), true));
    });
    document.body.classList.add('story-ready');
    if (scrollama) {
      // Derive the step from current geometry, including fast jumps and upward exits.
      const syncScrollStep = () => {
        if (compactLayout.matches || state.manual) return;
        let index = 0;
        steps.forEach((step, i) => { if (step.getBoundingClientRect().top <= innerHeight * .5) index = i; });
        if (index !== state.step) setStory(index);
      };
      scroller = scrollama().setup({ step: '#warming-story .story-step', offset: .5 })
        .onStepEnter(syncScrollStep).onStepExit(syncScrollStep);
    }
    compactLayout.addEventListener('change', () => { if (scroller) scroller.resize(); });
    window.addEventListener('resize', () => { if (scroller) scroller.resize(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') tooltip.hidden = true; });
    setStory(0);
  }

  async function init() {
    if (!d3 || !topojson) throw new Error('Local visualization libraries did not load.');
    const [mapData, bandData, countries, states] = await Promise.all([
      loadJSON('data/warming-grid.json'), loadJSON('data/latitude-bands.json'),
      loadJSON('data/countries-110m.json'), loadJSON('data/states-10m.json'),
    ]);
    grid = mapData; summary = bandData;
    const count = grid.grid.latitudes.length * grid.grid.longitudes.length;
    for (const key of Object.keys(seasons)) {
      if (grid.warming[key].length !== count || !grid.warming[key].every(Number.isFinite)) throw new Error(`Invalid ${key} grid`);
    }
    colorMax = Math.ceil(d3.max(Object.values(grid.warming), values => d3.max(values)) / 4) * 4;
    color = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, colorMax]).clamp(true);
    chartMax = Math.ceil(d3.max(summary.bands, band => d3.max(Object.values(band.warming))) / 2) * 2;
    d3.select('#region-select').selectAll('option').data([{ id: 'global', label: 'All latitudes' }, ...[...summary.bands].reverse()], d => d?.id)
      .join('option').attr('value', d => d.id).text(d => d.label);
    worldMap = createWorldMap(countries);
    usMap = createMap('#us-map', [-125, -66, 24, 50], countries, states);
    addLegend('#warming-legend'); addLegend('#us-legend');
    createChart();
    function updateUS() {
      usMap.update(state.usSeason);
      $('#us-summary').textContent = `${seasons[state.usSeason]} · 2081–2100 relative to 1995–2014 · Same 0–${colorMax}°C scale as the global map.`;
    }
    $('#us-season-select').addEventListener('change', event => { state.usSeason = event.target.value; updateUS(); });
    ['#season-select', '#region-select', '#us-season-select'].forEach(selector => { $(selector).disabled = false; });
    updateUS();
    setupStory();
  }

  init().catch(error => fail('The interactive explorer could not load. Please reload the page or use the seasonal data table below.', error));
})();
