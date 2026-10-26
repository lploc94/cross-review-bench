package com.github.binarywang.wxpay.service;

import com.github.binarywang.wxpay.bean.ecommerce.PartnerTransactionsCloseRequest;
import com.github.binarywang.wxpay.bean.ecommerce.TransactionsResult;
import com.github.binarywang.wxpay.bean.ecommerce.enums.TradeTypeEnum;
import com.github.binarywang.wxpay.bean.request.WxPayPartnerOrderCloseV3Request;
import com.github.binarywang.wxpay.service.impl.EcommerceServiceImpl;
import org.testng.Assert;
import org.testng.annotations.Test;

/**
 * Compile-time compatibility checks for the pre-#4014 e-commerce API.
 */
public class LegacyEcommerceApiCompatibilityTest {

  @Test
  public void shouldKeepLegacyTransactionResultAndTradeTypeAvailable() {
    TransactionsResult result = new TransactionsResult();

    Assert.assertNotNull(result);
    Assert.assertEquals(TradeTypeEnum.JSAPI.name(), "JSAPI");
  }

  @Test
  public void shouldPreserveOutTradeNoWhenMappingLegacyCloseRequest() throws Exception {
    PartnerTransactionsCloseRequest legacyRequest = new PartnerTransactionsCloseRequest();
    legacyRequest.setSpMchid("1230000109");
    legacyRequest.setSubMchid("1900000109");
    legacyRequest.setOutTradeNo("1217752501201407033233368018");

    final WxPayPartnerOrderCloseV3Request[] captured = new WxPayPartnerOrderCloseV3Request[1];
    EcommerceService service = new EcommerceServiceImpl(null) {
      @Override
      public void closePartnerOrder(WxPayPartnerOrderCloseV3Request request) {
        captured[0] = request;
      }
    };
    service.closePartnerTransactions(legacyRequest);

    WxPayPartnerOrderCloseV3Request unifiedRequest = captured[0];
    Assert.assertNotNull(unifiedRequest);
    Assert.assertEquals(unifiedRequest.getSpMchId(), "1230000109");
    Assert.assertEquals(unifiedRequest.getSubMchId(), "1900000109");
    Assert.assertEquals(unifiedRequest.getOutTradeNo(), "1217752501201407033233368018");
  }
}
