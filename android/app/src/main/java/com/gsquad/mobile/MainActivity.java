package com.gsquad.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		getBridge().getWebView().getSettings().setSupportZoom(false);
		getBridge().getWebView().getSettings().setBuiltInZoomControls(false);
		getBridge().getWebView().getSettings().setDisplayZoomControls(false);
	}
}
