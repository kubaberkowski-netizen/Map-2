package com.kubaberkowski.flaneur;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeWalkRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
