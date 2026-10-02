'use strict';
/*
 * API Manager - SOAP 1.1 / 1.2 envelope templates and header handling.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.APIManager = root.APIManager || {};
  root.APIManager.soap = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const TEMPLATES = {
    '1.1':
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"\n' +
      '                  xmlns:soapenc="http://www.w3.org/2002/04/encoder"\n' +
      '                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
      '  <soapenv:Body>\n' +
      '    <!-- <MyAction>\n' +
      '      <!-- <param>value</param> -->\n' +
      '    </MyAction> -->\n' +
      '  </soapenv:Body>\n' +
      '</soapenv:Envelope>\n',
    '1.2':
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope">\n' +
      '  <soapenv:Body>\n' +
      '    <!-- <MyAction>\n' +
      '      <!-- <param>value</param> -->\n' +
      '    </MyAction> -->\n' +
      '  </soapenv:Body>\n' +
      '</soapenv:Envelope>\n',
  };

  function template(version) {
    return version === '1.2' ? TEMPLATES['1.2'] : TEMPLATES['1.1'];
  }

  /**
   * Headers contributed by a SOAP body mode.
   * SOAP 1.1: Content-Type text/xml; charset=utf-8 + SOAPAction header.
   * SOAP 1.2: Content-Type application/soap+xml; charset=utf-8; action carried in Content-Type.
   */
  function soapHeaders(version, action) {
    const a = (action || '').trim();
    if (version === '1.2') {
      const ct = a ? 'application/soap+xml; charset=utf-8; action="' + a + '"' : 'application/soap+xml; charset=utf-8';
      return { 'Content-Type': ct };
    }
    const headers = { 'Content-Type': 'text/xml; charset=utf-8' };
    headers.SOAPAction = a ? '"' + a + '"' : '""';
    return headers;
  }

  return { TEMPLATES, template, soapHeaders };
});
