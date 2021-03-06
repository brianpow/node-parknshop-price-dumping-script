'use strict'
const program = require('commander')
const util = require('util')
const toCSV = require('array-to-csv')
const mkdirp = require('mkdirp')
const querystring = require('querystring')
//var http = require('http')
//var RateLimiter = require('limiter').RateLimiter;
const async = require('async')
const fs = require('fs')
const path = require('path')
const cheerio = require('cheerio')
let request = require('request')
request.defaults({
  jar: true
})
const throttledRequest = require('throttled-request')(request);
const URL = require('url')
let loaded = 0
let stage = 0
let domain = 'https://www.parknshop.com'
let categories = [],
  products = {},
  promotions = {},
  specialOffers = {},
  others = {}
let date = getLocalDate().toISOString().replace(/T.*/g, '')

let productHeaders = {
  'zh-hk': '網頁連結\t編號\t圖片路徑\t類別\t品牌\t貨品名稱\t貨品名稱\t尺寸\t建議售價\t售價\t優惠'.split('\t'),
  'en': 'url\tid\timage path\tCatagories\tBrand\tName\tName\tSize\tRecommended Retail Price\tSelling Price\tSpecial Offer'.split('\t')
}

let specialOfferHeaders = {
  'zh-hk': '額外折扣數量\t額外折扣\t平均單價'.split('\t'),
  'en': 'Bulk Quantities\tBulk Discount\tAverage Discounted Unit Price'.split('\t')
}
let othersHeaders = {
  'zh-hk': '最低平均售價\t最大折扣\t平均每一元買到的單位'.split('\t'),
  'en': 'Lowest Average Price\tDiscount\tUnit per dollar'.split('\t')
}
let promotionHeaders = {
  'zh-hk': '推廣',
  'en': 'promotion'
}
let finalHeaders = []
let outputFilename = generateFilename('complete', false)
program.version('1.0.2')
  .option('-s, --save <filename>', 'save file as <filename>.', outputFilename)
  .option('-D, --download-details', 'Download products detail and check for additional offer. (Warning: take lots of time)')
  .option('-d, --debug', 'save debug file')
  .option('-v, --verbose', 'print more details', verbosity, 0)
  .option('-f, --force-download', 'don\'t load cached webpages, always download from remote server')
  .option('-l, --limit <num>', 'limit max simultaneous downloads.', parseInt, 1)
  .option('-w, --wait <millisecond>', 'Wait between each connection.', parseInt, 2000)
  .option('-n, --no-cache', 'don\'t keep downloaded webpages')
  .option('-c, --cache <path>', 'path of cache', 'cache')
  .option('-r, --report <path>', 'path of report', 'report')
  .option('-o, --output-format <txt,...>', 'support tab-separated values (txt), comma-separated values (csv), excel (xlsx) or JSON (json)', list, ['txt'])
  .option('-a, --language <lang>', 'choose language (zh-hk = Traditional Chinese, en = English)', /(zh-hk|en)/, 'en')
  .option('-u, --user-agent <user-agent>', 'set user-agent', /.+/, 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36')
  .parse(process.argv)
outputFilename = outputFilename.replace("${language}", program.language)
//http.globalAgent.maxSockets = program.limit
banner()

if (!fs.existsSync(program.cache)) {
  fs.mkdirSync(program.cache);
}
if (!fs.existsSync(program.report)) {
  fs.mkdirSync(program.report);
}

throttledRequest.configure({
  requests: program.limit,
  milliseconds: 2000, //program.millisecond
});
process.stdout.write('Checking categories...')
let fullUrl = URL.resolve(domain, program.language)
httpdownload(fullUrl, path.join(program.cache, date, 'category', encodeURIComponent(fullUrl)), getCategory, downloadProducts)

function verbosity(v, total) {
  return total + 1
}

function httpdownload(url, filename, callback, finalCallback) {
  fs.exists(filename, function (exists) {
    if (program.forceDownload || !exists || exists && !fs.statSync(filename).size) {
      if (program.verbose)
        console.log('Downloading ' + url + ' as ' + filename + ' after ' + program.wait + ' milliseconds.')
      let p = path.parse(filename)
      mkdirp.sync(p.dir)
      // setTimeout(function () {
      _httpdownload(url, filename, callback, finalCallback)
      // }, program.wait)
    } else {
      if (program.verbose)
        console.log('Loading cached ' + url + ' named ' + filename)
      loaded++
      let data = fs.readFileSync(filename, {
        encoding: 'utf8'
      })

      if (data) {
        callback(data, url, finalCallback)
      }
    }
  })
}

function httpdownloadAsync(url, filename, callback) {
  fs.exists(filename, function (exists) {
    if (program.forceDownload || !exists || exists && !fs.statSync(filename).size) {
      if (program.verbose) console.log('Downloading ' + url + ' as ' + filename)
      let p = path.parse(filename)
      mkdirp.sync(p.dir)
      _httpdownloadAsync(url, filename, callback)
    } else {
      if (program.verbose) console.log('Loading cached ' + url + ' from ' + filename)
      loaded++
      let data = fs.readFileSync(filename, {
        encoding: 'utf8'
      })

      if (data) {

        callback(null, data)
      }
    }
  })
}

function downloadProducts(categories) {
  console.log(categories.length + ' categories found.')
  process.stdout.write('Checking products...')
  async.each(categories, function (url, callback) {
    let fullUrl = URL.resolve(domain, url)
    fullUrl = updateQueryString(fullUrl, {
      resultsForPage: 100
    })

    httpdownload(fullUrl, path.join(program.cache, date, 'products', encodeURIComponent(fullUrl)), getProducts, callback)
  }, function (err) {
    console.log(Object.keys(products).length + ' products found.')
    if (program.downloadDetails)
      downloadProductsDetails()
    else {
      let basename = generateFilename('products_only', false)
      let data = Object.assign(products)
      data[0] = productHeaders[program.language]
      let filenames = saveFile(path.join(program.report, basename), program.outputFormat, data)

      if (filenames.length) console.log('Basic products information saved to ' + filenames.join(', '))
      console.log('All done. Total time spent: ' + prettify(new Date().getTime() - time))
    }
  })
}

function saveFile(basename, formats, data) {
  let buff
  let names = []
  formats.forEach(function (format) {
    let name = basename + '.' + format
    try {
      switch (format) {
        case 'txt':
          if (program.verbose > 1)
            console.log(util.format("Saving %s...",name))
          fs.writeFileSync(name, toCSV(data, '\t'))
          names.push(name)
          break
        case 'csv':
          if (program.verbose > 1)
            console.log(util.format("Saving %s...",name))
          fs.writeFileSync(name, toCSV(data, ','))
          names.push(name)
          break
        case 'json':
          if (program.verbose > 1)
            console.log(util.format("Saving %s...",name))
          fs.writeFileSync(name, JSON.stringify(data))
          names.push(name)
          break
        case 'xlsx':
          const excel = require('msexcel-builder')
          let workbook = excel.createWorkbook(process.cwd(), name)
          let keys = Object.keys(data)
          let rows = keys.length
          let cols = 0
          keys.forEach(function (key) {
            cols = Math.max(cols, data[key].length)
          })


          let sheet1 = workbook.createSheet(date, cols, rows)
          keys.forEach(function (key, i) {
            for (let j = 0; j < data[key].length; j++)
              if (data[key][j]) sheet1.set(j + 1, i + 1, data[key][j])
          })
          if (program.verbose > 1)
            console.log(util.format("Saving %s...",name))
          workbook.saveSync();
          names.push(name)
          break
      }
    } catch (error) {
      console.error(error)
    }
  })
  return names
}

function downloadProductsDetails() {

  loaded = 0
  process.stdout.write('Checking special offer (It may take up to 2 hours, be patient)...')

  async.each(products, function (product, calllback) {
    let url = product[0]
    let id = product[1]
    httpdownload(url, path.join(program.cache, date, 'details', encodeURIComponent(url)), getProductDetail, calllback)
  }, function (err) {
    console.log('done.')
    process.stdout.write('Merging Products with special offers3')
    cleanUp()
    console.log('All done. Total time spent: ' + prettify(new Date().getTime() - time))
  })
}

function getLocalDate(time) {
  let d = time ? new Date(time) : new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() / 60)
}

function cleanUp() {
  process.stdout.write('Saving...')
  let filenames = saveFile(path.join(program.report, generateFilename('complete', false)), program.outputFormat, mergeProducts(products, specialOffers, promotions, others))

  console.log('saved to ' + filenames.join(', '))
  if (program.debug) {
    let basename = generateFilename('special_offers_only', false)
    saveFile(path.join(program.report, basename), program.outputFormat, specialOffers)
    basename = generateFilename('promotions_only', false)
    saveFile(path.join(program.report, basename), program.outputFormat, promotions)
    basename = generateFilename('stocks_only', false)
    saveFile(path.join(program.report, basename), program.outputFormat, others)
  } else {
    let basename = path.join(program.report, generateFilename('products_only', false))
    process.stdout.write('Removing...')
    let filenames = program.outputFormat.map(function (ext) {
      let filename = basename + '.' + ext
      try {
        if (fs.accessSync(filename, fs.F_OK)) fs.unlinkSync(filename)
      } catch (e) {}
      return filename
    })
    console.log(filenames.join(', ') + ' done.')
    let timeElapsed = new Date().getTime() - time
    console.log('Total time spent: ' + prettify(timeElapsed))
  }
}

function updateQueryString(url, newQuery) {
  let url2
  if (typeof url == 'string') {
    url2 = URL.parse(url, true)
  }
  for (let i in newQuery) {
    url2.query[i] = newQuery[i]
  }
  url2.search = '?' + querystring.stringify(url2.query)
  url2.path = url2.pathname + url2.search
  return typeof url == 'string' ? url2.format(url2) : url2
}

function _httpdownloadAsync(url, filename, callback) {
  let res = function (response) {
    let str = ''
    response.on('data', function (chunk) {
      str += chunk
    })
    response.on('error', function (e) {
      console.log(e)
      callback(null, str)
    })
    response.on('end', function () {
      try {
        fs.writeFileSync(filename, str)
      } catch (e) {
        console.error(e)
      }
      callback(null, str)
    })
  }
  let url2
  let params = {}
  if (typeof url == 'string') url2 = URL.parse(url, true)
  else {
    url2 = URL.parse(url.url, true)
    params = url
    delete params.url
  }
  try {

    let req = http.request(Object.assign({
      hostname: url2.hostname,
      port: url2.port,
      path: url2.path,
      method: 'GET',
      headers: {
        'User-Agent': program.userAgent,
        //'Cookie': 'lang=' + program.language
      }
    }, params), res)
    req.on('error', function (e) {
      console.log(e)
      callback(e)
    }).end()
  } catch (e) {
    console.error('Error when downloading ' + url)
    console.error(e)
    callback(e)
  }
}

function _httpdownload(url, filename, callback, finalCallback) {
  throttledRequest(url, function (error, response, body) {
    if (error) {
      console.error(error)
      callback('', url, finalCallback)
    } else {
      try {
        if (program.cache)
          fs.writeFileSync(filename, body)
      } catch (error) {
        console.error(error)
      }
      callback(body, url, finalCallback)
    }
  })
}

function _httpdownload_old(url, filename, callback, finalCallback) {

  let res = function (response) {
    let str = ''
    response.on('data', function (chunk) {
      console.log(chunk)
      str += chunk
    })
    response.on('error', function (e) {
      console.log(e)
      callback(str, url, finalCallback)
    })
    response.on('end', function () {
      try {
        if (program.cache) fs.writeFileSync(filename, str)
      } catch (e) {
        console.error(e)
      }
      callback(str, url, finalCallback)
    })
  }
  let url2
  let params = {}
  if (typeof url == 'string') url2 = URL.parse(url, true)
  else {
    url2 = URL.parse(url.url, true)
    params = url
    delete params.url
  }
  try {

    let req = http.request(Object.assign({
      hostname: url2.hostname,
      port: url2.port,
      path: url2.path,
      method: 'GET',
      headers: {
        'User-Agent': program.userAgent,
        'Cookie': 'lang=' + program.language
      }
    }, params), res)
    req.on('error', function (e) {
      console.log(e)
      callback('', url, finalCallback)
    }).end()
  } catch (e) {
    console.error('Error when downloading ' + url)
    console.error(e)
    finalCallback()
  }
}
let time = new Date().getTime()

let processed = 0

function getProductDetail(body, url, callback) {
  if (body.indexOf("Access Denied") > -1) {
    console.error("Server overloaded when downloading " + url)
    process.exit(1)
  }
  let $ = cheerio.load(body)
  let id = $('input[name=productCodePost]').attr('value')

  let specialOffer = []
  $('div.offer-table > div').each(function () {
    specialOffer.push([
      $(this).attr('data-value'),
      $('span.offAmount', this).text().replace('HK$', '').trim()
    ])
  })

  if (specialOffer.length > 1) specialOffers[id] = specialOffer

  let promotion = []
  $("div.TabPage-Special-Offers div.box").each(function () {
    specialOffer.push([
      $(this).find("div.title span").text(),
      $(this).find("div.info").text(),
      $(this).find("a").attr("href")
    ])
  })

  if (promotion.length > 1) promotions[id] = promotion

  // …
  processed++

  if (processed % 50 == 0) {

    if (loaded < processed) {
      let timeElapsed = new Date().getTime() - time
      let timeleft = timeElapsed / (processed - loaded) * (Object.keys(products).length - processed)
      process.stdout.clearLine()

      process.stdout.cursorTo(0)
      process.stdout.write(Object.keys(products).length - processed + ' products left, elapsed time: ' + prettify(timeElapsed) + ', estimated remaining time: ' + prettify(timeleft) + '/ ' + timeleft.toFixed() + ' seconds.')
    }
  }

  if (typeof callback == 'function') callback(null, specialOffer, promotion, [])
  return [
    specialOffer, promotion, []
  ]
}

function prettify(time, fmt) {
  fmt = fmt || '%Y years %m months %d days %h hours %i minutes %s seconds'
  let date = new Date(time)
  let str = []
  let Y = date.getUTCFullYear() - 1970
  let m = date.getUTCMonth()
  if (fmt.indexOf('%Y') == -1) m += Y * 12
  let d = date.getUTCDate() - 1
  let h = date.getUTCHours()
  if (fmt.indexOf('%d') == -1) h += d * 24
  let i = date.getUTCMinutes(),
    s = date.getUTCSeconds()
  if (Y) str.push(Y + ' years')
  if (m || str.length) str.push(m + ' months')
  if (d || str.length) str.push(d + ' days')
  if (h || str.length) str.push(h + ' hours')
  if (i || str.length) str.push(i + ' minutes')
  if (s || str.length) str.push(s + ' seconds')
  return str.join(' ')
}

function mergeProducts(products, specialOffers, promotions, others) {

  let mergedProducts = Object.assign(products)
  let count = 0
  let count2 = 0
  for (let i in specialOffers)
    count = count < specialOffers[i].length ? specialOffers[i].length - 1 : count
  count = count / 2 * 3
  for (let i in promotions)
    count2 = count2 < promotions[i].length ? promotions[i].length - 1 : count2
  finalHeaders = productHeaders[program.language]
  for (let i = 0; i < count / 3; i++)
    finalHeaders = finalHeaders.concat(specialOfferHeaders[program.language])
  finalHeaders = finalHeaders.concat(othersHeaders[program.language])
  for (let i = 0; i < count2; i++)
    finalHeaders = finalHeaders.concat(promotionHeaders[program.language])

  Object.keys(mergedProducts).forEach(function (id) {

    let match = false
    let minPrice = mergedProducts[id][9]

    if (others[id])

    {
      mergedProducts[id] = mergedProducts[id].concat(others[id].slice(1))
    }

    if (specialOffers[id])

    {
      let tmp = specialOffers[id].slice(1)
      while (tmp.length) {
        let tmp2 = tmp.slice(0, 2)
        let specialOfferPrice = Number(mergedProducts[id][9]) - Number(tmp[1]) / Number(tmp[0])
        tmp2.push(specialOfferPrice)

        if (specialOfferPrice < minPrice) minPrice = specialOfferPrice
        mergedProducts[id] = mergedProducts[id].concat(tmp2)
        tmp = tmp.slice(2)
      }
      for (let k = 0; k < count - (specialOffers[id].length - 1) / 2 * 3; k++)
        mergedProducts[id].push('\'-')
      match = true
    }
    if (!match)
      for (let k = 0; k < count; k++)
        mergedProducts[id].push('\'-')
    mergedProducts[id].push(minPrice)
    mergedProducts[id].push((1 - minPrice / mergedProducts[id][9]) * 100 + '%')

    let size = 1

    let parsedSize = mergedProducts[id][7].replace('BOX', '').replace(/[^0-9xX\.]/g, '').replace(/[xX]/g, '*')

    if (parsedSize.match(/^[\d\*]+$/g)) try {
      size = eval(parsedSize)
    } catch (e) {
      console.error(mergedProducts[id][7], parsedSize)
    }
    mergedProducts[id].push(minPrice / size)

    match = false

    if (promotions[id])

    {
      let tmp = promotions[id].slice(1)
      mergedProducts[id] = mergedProducts[id].concat(tmp)
      for (let k = 0; k < count2 - tmp.length; k++)
        mergedProducts[id].push('\'-')
      match = true
    }
    if (!match)
      for (let k = 0; k < count2; k++)
        mergedProducts[id].push('\'-')
  })


  let newProducts = []
  newProducts.push(finalHeaders)
  for (let i in mergedProducts)
    newProducts.push(mergedProducts[i])


  return newProducts
}

function getProducts(body, url, callback) {

  let $ = cheerio.load(body),
    product = []
  let brands = $('div.brand-container input[type=checkbox]').map(function () {
    return $(this).attr("data-value")
  }).get()
  if (program.debug) {
    let filename = path.join(program.cache, date, generateFilename("brands.txt", false))
    let cache = []
    if (fs.existsSync(filename)) {
      cache = fs.readFileSync(filename).toString().split("\n")
      brands = uniq(cache.concat(brands))
    }

    fs.writeFileSync(path.join(program.cache, date, generateFilename("brands.txt", false)), brands.join("\n"))
  }
  let category = $("#breadcrumb a").map(function () {
    return $(this).text().trim()
  }).get().join(" > ")
  $('div.product-container div.item').each(function (i, el) {
    let fullUrl = $(el).find('a').eq(0).attr('href').trim()
    //if(fullUrl.indexOf("/" + program.language+ "/") == -1)
    //{
    //	if(program.verbose > 3)
    //	console.log("Skipping url with wrong language: " + fullUrl )
    //	return
    //	}
    let uri = fullUrl.split('/')
    let id = uri[uri.length - 1].match('\\d+$')[0]
    //'en': 'url\tid\timage path\tBrand\tBrand\tName\tName\tSize\tRecommended Retail Price\tSelling Price\tSpecial Offer\tNo Stock?\tQuantity you can buy'.split('\t')
    let productName = $(el).find('div.name p').text()

    product = [
      URL.resolve(domain, fullUrl),
      id,
      $(el).find('img.lazy').eq(0).attr('src'),
      category, //$(el).find('div.name a').eq(0).text().trim().replace(productName, ""),
      $(el).find("div.homeProductCarousel").eq(0).attr("data-gtm-homeproductcarousel-brand"),
      //uri[1].substr(8),
      uri[2],
      productName,
      $(el).find('span.sizeUnit').eq(0).text().trim(),
      $(el).find('div.display-price div.rrp span').eq(0).text().replace('HK$', '').replace(',', '').trim(),
      $(el).find('div.display-price div.discount').eq(0).text().replace('HK$', '').replace(',', '').trim(),
      $(el).find('div.special-offer').eq(0).text().trim()
    ]

    let bulkDiscount = product[10].match(/([\d.]+) \/ ([\d.]+)/)
    if (bulkDiscount) {
      bulkDiscount = eval(bulkDiscount[0])
      product.push(bulkDiscount)
    } else
      product.push(product[9])
    if (program.verbose > 3)
      console.log(product)
    products[id] = product
  })

  let hasNextUrl = $('div.showMore').eq(0).attr('data-hasnextpage')
  if (hasNextUrl == "true") {
    let nextUrl = $('div.showMore').eq(0).attr('data-nextpageurl')
    if (program.verbose > 2)
      console.log("Found next url: " + nextUrl)
    if (nextUrl != 'javascript:void(0);' && nextUrl.indexOf("/c/") != -1) {
      let fullUrl = URL.resolve(domain, program.language + nextUrl)
      httpdownload(fullUrl, path.join(program.cache, date, 'products', encodeURIComponent(fullUrl)).substr(0, 240), getProducts, callback)
    } else {
      callback()
    }
  } else {
    callback()
  }
}

function getCategory(data, url, callback) {
  let $ = cheerio.load(data)

  let categories = $('a[href*="/c/"]').map(function () {
    return this.attribs.href
  }).get().filter(function (v) {
    return /\/c\/\d+[1-9]$/.test(v)
  })
  if (program.debug) {
    //console.log(categories)
    fs.writeFileSync(path.join(program.cache, date, generateFilename("categories.txt", false)), categories.join("\n"))
  }
  callback(categories)
}

function banner() {
  console.log('ParkNShop.com price dumping script')
}

function list(val) {
  let values = val.split(',')
  return values.filter(function (value) {
    return /(txt|csv|json|xlsx)/.test(value)
  })
}

function generateFilename(type, includeExtension) {
  return util.format("%s_%s_%s%s", getLocalDate().toISOString().replace(/T.*/g, ''), program.language, type, (includeExtension ? "." + program.outputFormat : ''))
}

function uniq(arr) {
  return arr.reduce(function (a, b) {
    if (a.indexOf(b) < 0) a.push(b);
    return a;
  }, []);
}